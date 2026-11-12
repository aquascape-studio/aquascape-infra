import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput, Tags, TimeZone } from "aws-cdk-lib";
import { Construct } from "constructs";
import { IVpc, Peer, Port, SecurityGroup, SubnetType } from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  FargateService,
  FargateTaskDefinition,
  ContainerImage,
  LogDriver,
  Protocol as EcsProtocol,
  CapacityProviderStrategy,
} from "aws-cdk-lib/aws-ecs";
import { Schedule } from "aws-cdk-lib/aws-applicationautoscaling";
import { Function as LambdaFunction, Runtime, Code } from "aws-cdk-lib/aws-lambda";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { HostedZone } from "aws-cdk-lib/aws-route53";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  TargetType,
  ListenerAction,
  ListenerCondition,
  HttpCodeTarget,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Table, AttributeType, BillingMode, StreamViewType } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess, BucketEncryption, HttpMethods } from "aws-cdk-lib/aws-s3";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  MathExpression,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { Budget } from "./Budget";

export interface AppStackProps extends StackProps {
  envName: "dev" | "stage" | "prod";
  domainName: string;
  vpc: IVpc;
  /** ACM certificate (us-east-1) used for the HTTPS listener on the ALB. */
  certificate: ICertificate;
  /**
   * Front web/api with an ALB. When false (dev today), CloudFront reaches the
   * web task directly at taskOriginHostname(), a DNS record kept pointing at
   * the running task's public IP. Flip to true when dev needs to scale out.
   */
  useAlb: boolean;
}

/** Name of the CloudFormation export carrying the ALB DNS name. */
export const albDnsExportName = (envName: string) => `aquascape-${envName}-alb-dns`;

/** DNS name CloudFront uses for the web task when there is no ALB. */
export const taskOriginHostname = (envName: string, domainName: string) =>
  `origin-${envName}.${domainName}`;

/** CloudFront origin-facing managed prefix list (us-east-1). */
const CLOUDFRONT_ORIGIN_PREFIX_LIST = "pl-3b927c52";

/**
 * App-tier: ECS Fargate cluster with THREE services behind one ALB.
 *
 *   web  (Next.js, :3000)        →  /          → CloudFront default pattern
 *   api  (Rust/tonic gRPC, :50051) → /grpc/*   → CloudFront HTTP/2 through
 *   sim  (Python gRPC, :50052)    (no public path — internal only)
 *
 * Only web and api are fronted by the ALB. Sim is reached internally over
 * Cloud Map service discovery (aquascape-sim.aquascape.local:50052) so the
 * api→sim hop never leaves the VPC.
 *
 * Storage:
 *   - DynamoDB: Scapes (pk/sk + GSI byOwner), Species (cache, read-heavy).
 *   - S3: user-uploaded reference images with lifecycle to Glacier @ 90d.
 *
 * CloudFront rewrites handled in EdgeStack; this stack only adds behaviors.
 */
export class AppStack extends Stack {
  readonly cluster: Cluster;
  readonly webService: FargateService;
  readonly apiService: FargateService;
  readonly simService: FargateService;
  readonly loadBalancer?: ApplicationLoadBalancer;
  readonly opsTopic: Topic;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const isProd = props.envName === "prod";
    const env = props.envName;
    const commonTags = { project: "aquascape-studio", env };

    // Non-prod runs at minimum size: 0.25 vCPU / 0.5 GB, public subnets (no NAT).
    const taskCpu = isProd ? 512 : 256;
    const taskMemory = isProd ? 1024 : 512;
    const taskSubnets = { subnetType: isProd ? SubnetType.PRIVATE_WITH_EGRESS : SubnetType.PUBLIC };
    // Non-prod runs on Fargate Spot (~70% cheaper; tasks may be reclaimed and restarted).
    const capacityProviderStrategies: CapacityProviderStrategy[] | undefined = isProd
      ? undefined
      : [{ capacityProvider: "FARGATE_SPOT", weight: 1 }];

    // ---- Cluster ----
    this.cluster = new Cluster(this, "Cluster", {
      clusterName: `aquascape-${env}`,
      vpc: props.vpc,
      containerInsights: isProd,
      enableFargateCapacityProviders: true,
      // Cloud Map namespace for internal service discovery (api → sim).
      defaultCloudMapNamespace: {
        name: "aquascape.local",
      },
    });

    // ---- ECR repos (one per deployable service) ----
    // web: MUTABLE tags, keep last 10 images (per feature spec)
    const webRepo = new Repository(this, "Repo-web", {
      repositoryName: `aquascape-web-${env}`,
      imageTagMutability: TagMutability.MUTABLE,
      lifecycleRules: [{ maxImageCount: 10 }],
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    Tags.of(webRepo).add("project", commonTags.project);
    Tags.of(webRepo).add("env", env);

    const mkRepo = (name: string) =>
      new Repository(this, `Repo-${name}`, {
        repositoryName: `aquascape-${name}-${env}`,
        imageTagMutability: TagMutability.IMMUTABLE,
        lifecycleRules: [{ maxImageCount: 20 }],
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });
    const apiRepo = mkRepo("api");
    const simRepo = mkRepo("sim");

    // ---- DynamoDB ----
    const scapesTable = new Table(this, "ScapesTable", {
      tableName: `aquascape-scapes-${props.envName}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    scapesTable.addGlobalSecondaryIndex({
      indexName: "byOwner",
      partitionKey: { name: "owner_user_id", type: AttributeType.STRING },
      sortKey: { name: "pk", type: AttributeType.STRING },
    });

    const speciesTable = new Table(this, "SpeciesTable", {
      tableName: `aquascape-species-${props.envName}`,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const usersTable = new Table(this, "UsersTable", {
      tableName: `aquascape-users-${props.envName}`,
      partitionKey: { name: "email", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ---- S3: uploads ----
    const uploads = new Bucket(this, "UploadsBucket", {
      bucketName: `aquascape-uploads-${props.envName}-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: "transition-archive",
          transitions: [
            { storageClass: { value: "GLACIER" } as never, transitionAfter: Duration.days(90) },
          ],
          enabled: true,
        },
      ],
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.PUT, HttpMethods.POST],
          allowedOrigins: ["*"], // tightened in Phase 3
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // ---- Cost guardrail + ops topic ----
    new Budget(this, "Budget", {
      envName: props.envName,
      monthlyLimitUsd: isProd ? 600 : 150,
      notifyEmail: "chengxiaopusuperman@gmail.com",
    });

    this.opsTopic = new Topic(this, "OpsTopic", {
      topicName: `aquascape-ops-${props.envName}`,
      displayName: `Aquascape ops alerts (${props.envName})`,
    });
    this.opsTopic.addSubscription(new EmailSubscription("chengxiaopusuperman@gmail.com"));

    // ---- ALB + SGs ----
    let albSg: SecurityGroup | undefined;
    if (props.useAlb) {
      albSg = new SecurityGroup(this, "AlbSg", {
        vpc: props.vpc,
        description: `aquascape ALB SG (${props.envName})`,
        allowAllOutbound: true,
      });
      albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80), "HTTP from CloudFront (redirect to HTTPS)");
      albSg.addIngressRule(Peer.anyIpv4(), Port.tcp(443), "HTTPS from CloudFront");
      Tags.of(albSg).add("project", commonTags.project);
      Tags.of(albSg).add("env", env);

      this.loadBalancer = new ApplicationLoadBalancer(this, "Alb", {
        vpc: props.vpc,
        internetFacing: true,
        loadBalancerName: `aquascape-${env}`,
        securityGroup: albSg,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
      });
      Tags.of(this.loadBalancer).add("project", commonTags.project);
      Tags.of(this.loadBalancer).add("env", env);
    }

    // ---- Shared log group helper ----
    const mkLogGroup = (name: string) =>
      new LogGroup(this, `Logs-${name}`, {
        logGroupName: `/aquascape/${name}/${props.envName}`,
        retention: isProd ? RetentionDays.ONE_MONTH : RetentionDays.TWO_WEEKS,
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });

    // ---- WEB service (Next.js) ----
    // 0.5 vCPU / 1 GB in prod (0.25 / 0.5 GB otherwise), scoped task role: SSM read + CloudWatch logs write
    const webLogs = mkLogGroup("web");
    const webTask = new FargateTaskDefinition(this, "WebTaskDef", {
      family: `aquascape-web-${env}`,
      cpu: taskCpu,
      memoryLimitMiB: taskMemory,
    });
    Tags.of(webTask).add("project", commonTags.project);
    Tags.of(webTask).add("env", env);

    // Scoped SSM read permission (only /aquascape/<env>/* params)
    webTask.taskRole.addToPrincipalPolicy(new PolicyStatement({
      sid: "SsmReadAquascapeParams",
      effect: Effect.ALLOW,
      actions: [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/aquascape/${env}/*`,
      ],
    }));

    // CloudWatch Logs write (restricted to the web log group)
    webTask.taskRole.addToPrincipalPolicy(new PolicyStatement({
      sid: "CwLogsWriteWeb",
      effect: Effect.ALLOW,
      actions: [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
      ],
      resources: [
        webLogs.logGroupArn,
        `${webLogs.logGroupArn}:*`,
      ],
    }));

    // Grant execution role permission to pull from the web ECR repo.
    webRepo.grantPull(webTask.obtainExecutionRole());

    usersTable.grantReadWriteData(webTask.taskRole);

    webTask.addContainer("web", {
      containerName: "web",
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
      command: ["sh", "-c",
        "sed -i 's/listen\\s*80;/listen 3000;/g; s/listen\\s*\\[::\\]:80;/listen [::]:3000;/g' " +
        "/etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"],
      portMappings: [{ containerPort: 3000, protocol: EcsProtocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: "web", logGroup: webLogs }),
      environment: {
        NODE_ENV: "production",
        AQUASCAPE_ENV: env,
        NEXT_PUBLIC_API_BASE_URL: `https://${env === "prod" ? "" : `${env}.`}${props.domainName}/grpc`,
        DDB_TABLE_USERS: usersTable.tableName,
      },
      essential: true,
    });

    const webSg = new SecurityGroup(this, "WebSg", {
      vpc: props.vpc,
      description: `aquascape web task SG (${env})`,
      allowAllOutbound: true,
    });
    if (albSg) {
      webSg.addIngressRule(albSg, Port.tcp(3000), "from ALB to web");
    } else {
      webSg.addIngressRule(Peer.prefixList(CLOUDFRONT_ORIGIN_PREFIX_LIST), Port.tcp(3000), "from CloudFront to web");
    }
    Tags.of(webSg).add("project", commonTags.project);
    Tags.of(webSg).add("env", env);

    this.webService = new FargateService(this, "WebService", {
      serviceName: `aquascape-web-${env}`,
      cluster: this.cluster,
      taskDefinition: webTask,
      desiredCount: isProd ? 2 : 1,
      minHealthyPercent: isProd ? 50 : 0,
      maxHealthyPercent: 200,
      assignPublicIp: !isProd,
      vpcSubnets: taskSubnets,
      capacityProviderStrategies,
      securityGroups: [webSg],
      enableExecuteCommand: !isProd,
      // Circuit breaker omitted: placeholder image won't pass health checks until real
      // app images are pushed. Re-enable circuitBreaker once real images are deployed.
      healthCheckGracePeriod: props.useAlb ? Duration.seconds(300) : undefined,
    });
    Tags.of(this.webService).add("project", commonTags.project);
    Tags.of(this.webService).add("env", env);

    // ---- Autoscaling: web service (min 1 / max 4, CPU target 60%) ----
    const webScaling = this.webService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: isProd ? 4 : 1 });
    webScaling.scaleOnCpuUtilization("WebCpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60),
    });

    // ---- API service (Rust gRPC) ----
    const apiLogs = mkLogGroup("api");
    const apiTask = new FargateTaskDefinition(this, "ApiTaskDef", {
      family: `aquascape-api-${props.envName}`,
      cpu: taskCpu,
      memoryLimitMiB: taskMemory,
    });
    scapesTable.grantReadWriteData(apiTask.taskRole);
    speciesTable.grantReadData(apiTask.taskRole);
    uploads.grantReadWrite(apiTask.taskRole);
    apiRepo.grantPull(apiTask.obtainExecutionRole());

    apiTask.addContainer("api", {
      containerName: "api",
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
      command: ["sh", "-c",
        "sed -i 's/listen\\s*80;/listen 50051;/g; s/listen\\s*\\[::\\]:80;/listen [::]:50051;/g' " +
        "/etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"],
      portMappings: [{ containerPort: 50051, protocol: EcsProtocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: "api", logGroup: apiLogs }),
      environment: {
        AWS_REGION: Stack.of(this).region,
        DDB_TABLE_SCAPES: scapesTable.tableName,
        DDB_TABLE_SPECIES: speciesTable.tableName,
        SIM_ADDR: "http://aquascape-sim.aquascape.local:50052",
        RUST_LOG: "info",
      },
      essential: true,
    });

    const apiSg = new SecurityGroup(this, "ApiSg", {
      vpc: props.vpc,
      description: `aquascape api task SG (${props.envName})`,
      allowAllOutbound: true,
    });
    if (albSg) {
      apiSg.addIngressRule(albSg, Port.tcp(50051), "from ALB to api");
    }

    this.apiService = new FargateService(this, "ApiService", {
      serviceName: `aquascape-api-${props.envName}`,
      cluster: this.cluster,
      taskDefinition: apiTask,
      // Non-prod: 0 until a real api image ships (currently the nginx placeholder).
      desiredCount: isProd ? 2 : 0,
      minHealthyPercent: isProd ? 50 : 0,
      maxHealthyPercent: 200,
      assignPublicIp: !isProd,
      vpcSubnets: taskSubnets,
      capacityProviderStrategies,
      securityGroups: [apiSg],
      enableExecuteCommand: !isProd,
      healthCheckGracePeriod: props.useAlb ? Duration.seconds(300) : undefined,
    });

    // ---- SIM service (Python gRPC, internal only via Cloud Map) ----
    const simLogs = mkLogGroup("sim");
    const simTask = new FargateTaskDefinition(this, "SimTaskDef", {
      family: `aquascape-sim-${props.envName}`,
      cpu: taskCpu,
      memoryLimitMiB: taskMemory,
    });
    simRepo.grantPull(simTask.obtainExecutionRole());
    simTask.addContainer("sim", {
      containerName: "sim",
      image: ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
      portMappings: [{ containerPort: 50052, protocol: EcsProtocol.TCP }],
      logging: LogDriver.awsLogs({ streamPrefix: "sim", logGroup: simLogs }),
      environment: {
        LOG_LEVEL: "INFO",
        PORT: "50052",
      },
      essential: true,
    });

    const simSg = new SecurityGroup(this, "SimSg", {
      vpc: props.vpc,
      description: `aquascape sim task SG (${props.envName})`,
      allowAllOutbound: true,
    });
    // Only api can reach sim.
    simSg.addIngressRule(apiSg, Port.tcp(50052), "from api to sim");

    this.simService = new FargateService(this, "SimService", {
      serviceName: `aquascape-sim-${props.envName}`,
      cluster: this.cluster,
      taskDefinition: simTask,
      desiredCount: 1,
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      assignPublicIp: !isProd,
      vpcSubnets: taskSubnets,
      capacityProviderStrategies,
      securityGroups: [simSg],
      enableExecuteCommand: !isProd,
      cloudMapOptions: {
        name: "aquascape-sim",
        containerPort: 50052,
      },
    });

    // ---- Non-prod dev window: run daily 01:30–04:00 Pacific, scale to 0 otherwise ----
    // Covers the "aquascape 每日迭代" Claude routine (daily 01:51 PST).
    // Wake manually outside the window: scripts/wake-dev.sh
    if (!isProd) {
      const tz = TimeZone.AMERICA_LOS_ANGELES;
      const simScaling = this.simService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 1 });
      for (const [name, scaling] of [["Web", webScaling], ["Sim", simScaling]] as const) {
        scaling.scaleOnSchedule(`${name}Wake`, {
          schedule: Schedule.cron({ minute: "30", hour: "1" }),
          timeZone: tz,
          minCapacity: 1,
          maxCapacity: 1,
        });
        scaling.scaleOnSchedule(`${name}Sleep`, {
          schedule: Schedule.cron({ minute: "0", hour: "4" }),
          timeZone: tz,
          minCapacity: 0,
          maxCapacity: 0,
        });
      }
    }

    if (this.loadBalancer) {
      const loadBalancer = this.loadBalancer;
      // ---- ALB target groups + listeners ----
      const webTg = new ApplicationTargetGroup(this, "WebTg", {
        vpc: props.vpc,
        port: 3000,
        protocol: ApplicationProtocol.HTTP,
        targetType: TargetType.IP,
        targets: [this.webService],
        healthCheck: {
          // "/healthz" expected once real app image is deployed; placeholder nginx returns 404
          path: "/",
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          healthyHttpCodes: "200-499",
        },
        deregistrationDelay: Duration.seconds(30),
      });
      Tags.of(webTg).add("project", commonTags.project);
      Tags.of(webTg).add("env", env);

      const apiTg = new ApplicationTargetGroup(this, "ApiTg", {
        vpc: props.vpc,
        port: 50051,
        protocol: ApplicationProtocol.HTTP,
        protocolVersion: undefined, // HTTP/1.1 + Connect framing; gRPC-Web target type would be HTTP/2.
        targetType: TargetType.IP,
        targets: [this.apiService],
        healthCheck: {
          path: "/grpc.health.v1.Health/Check",
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          healthyHttpCodes: "200-499",
        },
        deregistrationDelay: Duration.seconds(30),
      });

      // HTTP listener: redirect all traffic to HTTPS
      loadBalancer.addListener("HttpListener", {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultAction: ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });

      // HTTPS listener (port 443) with ACM certificate
      const httpsListener = loadBalancer.addListener("HttpsListener", {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [props.certificate],
        defaultAction: ListenerAction.forward([webTg]),
      });
      Tags.of(httpsListener).add("project", commonTags.project);
      Tags.of(httpsListener).add("env", env);

      httpsListener.addAction("ApiAction", {
        priority: 10,
        conditions: [
          ListenerCondition.pathPatterns(["/grpc/*", "/aquascape.v1.*"]),
        ],
        action: ListenerAction.forward([apiTg]),
      });

      new StringParameter(this, "AlbDnsNameParam", {
        parameterName: `/aquascape/${props.envName}/alb-dns-name`,
        stringValue: loadBalancer.loadBalancerDnsName,
        description: "ALB DNS name for CloudFront origin",
      });

      // ---- Export ALB DNS name for EdgeStack to consume via Fn::ImportValue ----
      // CloudFront behaviors are wired in EdgeStack.wireAlbBehaviors() using
      // Fn.importValue so that the ALB DNS is NOT a synth-time CDK cross-stack
      // Ref (which would create a dependency cycle). CloudFormation handles the
      // deploy-time ordering via stack exports.
      new CfnOutput(this, "AlbDnsExport", {
        value: loadBalancer.loadBalancerDnsName,
        exportName: albDnsExportName(env),
      });

      // ---- Alarms (web 5xx, api 5xx, latency) ----
      for (const [tgName, tg] of [
        ["web", webTg] as const,
        ["api", apiTg] as const,
      ]) {
        const reqs = loadBalancer.metrics.requestCount({
          period: Duration.minutes(5),
        });
        const err5xx = tg.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT, {
          period: Duration.minutes(5),
        });
        const ratio = new MathExpression({
          expression: "IF(reqs > 0, (err5xx / reqs) * 100, 0)",
          usingMetrics: { reqs, err5xx },
          period: Duration.minutes(5),
          label: `${tgName} 5xx ratio %`,
        });
        const alarm = new Alarm(this, `${tgName}5xxRatioAlarm`, {
          alarmName: `aquascape-${props.envName}-${tgName}-5xx-ratio`,
          metric: ratio,
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        });
        alarm.addAlarmAction(new SnsAction(this.opsTopic));
      }
    }

    // ---- No ALB: keep taskOriginHostname() pointing at the running web task ----
    // Fires on every web task start (deploys, Spot replacement, scheduled wake).
    if (!this.loadBalancer) {
      const zone = HostedZone.fromLookup(this, "Zone", { domainName: props.domainName });
      const recordName = taskOriginHostname(env, props.domainName);
      const originDns = new LambdaFunction(this, "WebOriginDns", {
        functionName: `aquascape-web-origin-dns-${env}`,
        runtime: Runtime.NODEJS_22_X,
        handler: "index.handler",
        timeout: Duration.seconds(30),
        environment: { ZONE_ID: zone.hostedZoneId, RECORD_NAME: recordName },
        code: Code.fromInline(`
const { EC2Client, DescribeNetworkInterfacesCommand } = require("@aws-sdk/client-ec2");
const { Route53Client, ChangeResourceRecordSetsCommand } = require("@aws-sdk/client-route-53");
const ec2 = new EC2Client({});
const r53 = new Route53Client({});
exports.handler = async (event) => {
  const eni = (event.detail.attachments || [])
    .flatMap((a) => a.details || [])
    .find((d) => d.name === "networkInterfaceId")?.value;
  if (!eni) throw new Error("no ENI on task " + event.detail.taskArn);
  const res = await ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eni] }));
  const ip = res.NetworkInterfaces?.[0]?.Association?.PublicIp;
  if (!ip) throw new Error("no public IP on " + eni);
  await r53.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: process.env.ZONE_ID,
    ChangeBatch: { Changes: [{ Action: "UPSERT", ResourceRecordSet: {
      Name: process.env.RECORD_NAME, Type: "A", TTL: 60, ResourceRecords: [{ Value: ip }],
    } }] },
  }));
  console.log(process.env.RECORD_NAME + " -> " + ip);
};
`),
      });
      originDns.addToRolePolicy(new PolicyStatement({
        actions: ["ec2:DescribeNetworkInterfaces"],
        resources: ["*"],
      }));
      originDns.addToRolePolicy(new PolicyStatement({
        actions: ["route53:ChangeResourceRecordSets"],
        resources: [zone.hostedZoneArn],
      }));
      new Rule(this, "WebTaskRunningRule", {
        description: `Point ${recordName} at the web task when it starts`,
        eventPattern: {
          source: ["aws.ecs"],
          detailType: ["ECS Task State Change"],
          detail: {
            clusterArn: [this.cluster.clusterArn],
            group: [`service:${this.webService.serviceName}`],
            lastStatus: ["RUNNING"],
          },
        },
        targets: [new LambdaTarget(originDns)],
      });
    }

    // ---- Outputs ----
    new CfnOutput(this, "UploadsBucketName", { value: uploads.bucketName });
    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "EcrWebUri", { value: webRepo.repositoryUri });
    new CfnOutput(this, "EcrApiUri", { value: apiRepo.repositoryUri });
    new CfnOutput(this, "EcrSimUri", { value: simRepo.repositoryUri });
    if (this.loadBalancer) {
      new CfnOutput(this, "AlbDnsName", { value: this.loadBalancer.loadBalancerDnsName });
    }
    new CfnOutput(this, "OpsTopicArn", { value: this.opsTopic.topicArn });
    new CfnOutput(this, "ScapesTableName", { value: scapesTable.tableName });
    new CfnOutput(this, "SpeciesTableName", { value: speciesTable.tableName });
  }
}
