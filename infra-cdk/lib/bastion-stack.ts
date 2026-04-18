import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BastionStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;  // imported from DataStack; already has ingress paths to db/redis
}

export class BastionStack extends cdk.Stack {
  public readonly bastion: ec2.BastionHostLinux;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, props);
    this.bastion = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO), // tiny is fine for SSM jump
    });
    this.bastion.instance.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );
    // Attach the bastion to appSg. appSg already has ingress rules into
    // the DB SG (5432) and Redis SG (6379), so piggy-backing gives the
    // bastion exactly the reachability it needs without creating new
    // cross-stack security-group references.
    this.bastion.instance.addSecurityGroup(props.appSg);

    new cdk.CfnOutput(this, 'BastionInstanceId', { value: this.bastion.instanceId });
  }
}
