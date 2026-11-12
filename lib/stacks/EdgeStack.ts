import { Fn, Stack, StackProps, RemovalPolicy, CfnOutput } from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, BlockPublicAccess, BucketEncryption } from "aws-cdk-lib/aws-s3";
import {
  Distribution,
  ViewerProtocolPolicy,
  CachePolicy,
  PriceClass,
  HttpVersion,
  AllowedMethods,
  CachedMethods,
  OriginRequestPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin, HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { OriginProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { Certificate, CertificateValidation, ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { HostedZone, ARecord, AaaaRecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

export interface EdgeStackProps extends StackProps {
  envName: "dev" | "stage" | "prod";
  domainName: string; // apex, e.g. efferves.live
  subdomain?: string; // "dev" | "stage" | undefined (for prod/apex)
}

/**
 * Edge layer: static assets bucket, CloudFront distribution, Route53 records,
 * ACM certificate. App-specific ALB behaviors are added by calling
 * wireAlbBehaviors() from bin/aquascape.ts after AppStack is instantiated,
 * using Fn.importValue to avoid a dependency cycle.
 */
export class EdgeStack extends Stack {
  readonly siteBucket: Bucket;
  readonly distribution: Distribution;
  readonly hostedZone: HostedZone;
  /** ACM certificate (us-east-1) for CloudFront + ALB HTTPS listeners. */
  readonly certificate: ICertificate;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const fqdn = props.subdomain
      ? `${props.subdomain}.${props.domainName}`
      : props.domainName;

    this.hostedZone = HostedZone.fromLookup(this, "Zone", {
      domainName: props.domainName,
    }) as HostedZone;

    this.certificate = new Certificate(this, "Cert", {
      domainName: fqdn,
      subjectAlternativeNames:
        props.envName === "prod" ? [`www.${props.domainName}`] : undefined,
      validation: CertificateValidation.fromDns(this.hostedZone),
    });

    this.siteBucket = new Bucket(this, "SiteBucket", {
      bucketName: `aquascape-studio-site-${props.envName}-${this.account}`,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: props.envName === "prod" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: props.envName !== "prod",
    });

    // WAF WebACL (CloudFront scope must be in us-east-1, same as this stack).
    // Rules: AWS Managed Common + IP Reputation + rate limit per IP.
    // Prod only (~$9/mo); dev relies on CloudFront alone.
    const waf = props.envName !== "prod" ? undefined : new CfnWebACL(this, "Waf", {
      name: `aquascape-${props.envName}`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `aquascape-${props.envName}`,
      },
      rules: [
        {
          name: "IPReputation",
          priority: 10,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "IPReputation",
          },
        },
        {
          name: "CommonRules",
          priority: 20,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "CommonRules",
          },
        },
        {
          // Block IPs that exceed 2000 req / 5 min.
          name: "RateLimit",
          priority: 30,
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: "IP",
            },
          },
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimit",
          },
        },
      ],
    });

    this.distribution = new Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
      },
      domainNames: props.envName === "prod"
        ? [fqdn, `www.${props.domainName}`]
        : [fqdn],
      certificate: this.certificate,
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,

      enableLogging: props.envName === "prod",
      webAclId: waf?.attrArn,
    });

    new ARecord(this, "AliasA", {
      zone: this.hostedZone,
      recordName: fqdn,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });
    new AaaaRecord(this, "AliasAAAA", {
      zone: this.hostedZone,
      recordName: fqdn,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });

    if (props.envName === "prod") {
      new ARecord(this, "WwwAliasA", {
        zone: this.hostedZone,
        recordName: `www.${props.domainName}`,
        target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
      });
    }

    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "DomainName", { value: fqdn });
    new CfnOutput(this, "SiteBucketName", { value: this.siteBucket.bucketName });
  }

  /**
   * Wire ALB-backed CloudFront behaviors after AppStack is instantiated.
   *
   * Uses Fn.importValue(albDnsExportName) so that the ALB DNS name is
   * resolved at CloudFormation deploy time (Fn::ImportValue intrinsic),
   * NOT as a CDK cross-stack construct reference. This breaks the dependency
   * cycle that would otherwise occur because AppStack depends on EdgeStack
   * (for the ACM certificate) while EdgeStack would need the ALB from AppStack.
   *
   * Call this from bin/aquascape.ts after both EdgeStack and AppStack are
   * instantiated:
   *   edge.wireAlbBehaviors(albDnsExportName(envName));
   */
  wireAlbBehaviors(albDnsExportName: string): void {
    const albOrigin = new HttpOrigin(Fn.importValue(albDnsExportName), {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
      httpsPort: 443,
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(5),
    });

    for (const pattern of ["/grpc/*", "/api/*", "/*"]) {
      this.distribution.addBehavior(pattern, albOrigin, {
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
        compress: true,
      });
    }
  }
}
