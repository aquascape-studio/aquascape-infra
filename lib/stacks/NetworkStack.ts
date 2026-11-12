import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Vpc, IVpc, SubnetType, NatProvider } from "aws-cdk-lib/aws-ec2";

export interface NetworkStackProps extends StackProps {
  envName: "dev" | "stage" | "prod";
}

export class NetworkStack extends Stack {
  readonly vpc: IVpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const isProd = props.envName === "prod";

    this.vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      // Non-prod: no NAT (~$37/mo). Tasks run in public subnets with public IPs instead.
      natGateways: isProd ? 2 : 0,
      natGatewayProvider: NatProvider.gateway(),
      subnetConfiguration: [
        { name: "public",  cidrMask: 24, subnetType: SubnetType.PUBLIC },
        { name: "private", cidrMask: 22, subnetType: isProd ? SubnetType.PRIVATE_WITH_EGRESS : SubnetType.PRIVATE_ISOLATED },
      ],
    });
    this.vpc.applyRemovalPolicy(isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
  }
}
