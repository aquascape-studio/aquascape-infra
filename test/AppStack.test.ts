import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { AppStack } from "../lib/stacks/AppStack";

/**
 * Unit tests for AppStack — specifically the aquascape-web Fargate service.
 *
 * Uses aws-cdk-lib/assertions to assert resource properties without
 * requiring a real AWS account or deployment.
 */
describe("AppStack — aquascape-web ECS Fargate feature", () => {
  let template: Template;
  const envName = "dev";

  beforeAll(() => {
    const app = new cdk.App();

    // Minimal dependency stubs so AppStack can synthesize without a real account.
    const envProps = { account: "123456789012", region: "us-east-1" };

    // Stub VPC
    const networkStack = new cdk.Stack(app, "TestNetworkStack", { env: envProps });
    const vpc = new Vpc(networkStack, "TestVpc", { maxAzs: 2, natGateways: 1 });

    // Stub ACM certificate (imported by ARN — no cross-stack dependency created)
    const certStack = new cdk.Stack(app, "TestCertStack", { env: envProps });
    const certificate = Certificate.fromCertificateArn(
      certStack,
      "TestCert",
      "arn:aws:acm:us-east-1:123456789012:certificate/test-cert-id",
    );

    const appStack = new AppStack(app, "TestAppStack", {
      env: envProps,
      envName,
      domainName: "example.com",
      vpc,
      certificate,
    });

    template = Template.fromStack(appStack);
  });

  // ── ECR ──────────────────────────────────────────────────────────────────

  test("ECR repository exists with correct name and MUTABLE tag mutability", () => {
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: `aquascape-web-${envName}`,
      ImageTagMutability: "MUTABLE",
    });
  });

  test("ECR web repo has lifecycle rule keeping last 10 images", () => {
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: `aquascape-web-${envName}`,
      LifecyclePolicy: {
        LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":10'),
      },
    });
  });

  // ── ECS Cluster ──────────────────────────────────────────────────────────

  test("ECS cluster exists", () => {
    template.resourceCountIs("AWS::ECS::Cluster", 1);
    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: `aquascape-${envName}`,
    });
  });

  // ── Fargate task definition ───────────────────────────────────────────────

  test("Web Fargate task definition has 0.25 vCPU (256) and 0.5 GB (512 MiB) memory in dev", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: `aquascape-web-${envName}`,
      Cpu: "256",
      Memory: "512",
    });
  });

  test("Web task definition exposes port 3000", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: `aquascape-web-${envName}`,
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 3000, Protocol: "tcp" }),
          ]),
        }),
      ]),
    });
  });

  test("Web task role has SSM GetParameter permissions scoped to /aquascape/dev/*", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "SsmReadAquascapeParams",
            Action: Match.arrayWith(["ssm:GetParameter"]),
            Effect: "Allow",
            // CDK synthesizes a single-resource statement as a plain string
            Resource: Match.stringLikeRegexp("parameter/aquascape/dev/\\*"),
          }),
        ]),
      },
    });
  });

  test("Web task role has CloudWatch Logs write permissions", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "CwLogsWriteWeb",
            Action: Match.arrayWith(["logs:PutLogEvents"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  // ── Fargate service ───────────────────────────────────────────────────────

  test("Web Fargate service exists on Fargate Spot in dev", () => {
    template.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: `aquascape-web-${envName}`,
      CapacityProviderStrategy: [{ CapacityProvider: "FARGATE_SPOT", Weight: 1 }],
    });
  });

  test("Web service autoscaling target is configured (min 1 / max 1) with dev window schedule", () => {
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 1,
      MaxCapacity: 1,
      ScheduledActions: Match.arrayWith([
        Match.objectLike({ ScheduledActionName: "WebWake", Schedule: "cron(30 1 * * ? *)" }),
        Match.objectLike({ ScheduledActionName: "WebSleep", Schedule: "cron(0 4 * * ? *)" }),
      ]),
    });
  });

  test("Web service CPU target tracking policy targets 60%", () => {
    template.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        TargetValue: 60,
      }),
    });
  });

  // ── ALB ──────────────────────────────────────────────────────────────────

  test("ALB HTTPS listener exists on port 443", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
    });
  });

  test("ALB HTTP listener on port 80 redirects to HTTPS", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      Protocol: "HTTP",
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: "redirect",
          RedirectConfig: Match.objectLike({
            Protocol: "HTTPS",
            Port: "443",
            StatusCode: "HTTP_301",
          }),
        }),
      ]),
    });
  });

  test("Web target group health check uses /healthz path on port 3000", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Port: 3000,
      HealthCheckPath: "/healthz",
    });
  });
});
