import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { TtConfig } from './config';

export interface VpcStackProps extends cdk.StackProps {
  readonly cfg: TtConfig;
}

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: VpcStackProps) {
    super(scope, id, props);
    const { cfg } = props;

    this.vpc = new ec2.Vpc(this, 'TtVpc', {
      ipAddresses: ec2.IpAddresses.cidr(cfg.vpcCidr),
      maxAzs: cfg.azCount,
      // One NAT gateway per AZ, per memory/feedback_budget_comfortable.md —
      // a single shared NAT would be an SPOF, contradicting the whole point.
      natGateways: cfg.azCount,
      subnetConfiguration: [
        { name: 'Public',   subnetType: ec2.SubnetType.PUBLIC,              cidrMask: 24 },
        { name: 'Private',  subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED,    cidrMask: 24 },
      ],
    });

    // S3 gateway endpoint: free, makes ECR image pulls cheaper / faster.
    this.vpc.addGatewayEndpoint('S3GwEndpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // Interface endpoints that the compute stack will use later. Declaring them
    // here keeps VPC-level networking in one place.
    const interfaceSvc: [string, ec2.InterfaceVpcEndpointAwsService][] = [
      ['EcrApi',          ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDocker',       ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['CloudWatchLogs',  ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['SecretsManager',  ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['Ssm',             ec2.InterfaceVpcEndpointAwsService.SSM],
      ['SsmMessages',     ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES],
      ['Ec2Messages',     ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES],
    ];
    for (const [id, svc] of interfaceSvc) {
      this.vpc.addInterfaceEndpoint(id, {
        service: svc,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }

    new cdk.CfnOutput(this, 'VpcId',             { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'PrivateSubnetIds',  { value: this.vpc.privateSubnets.map(s => s.subnetId).join(',') });
    new cdk.CfnOutput(this, 'IsolatedSubnetIds', { value: this.vpc.isolatedSubnets.map(s => s.subnetId).join(',') });
  }
}
