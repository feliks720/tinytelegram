import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { TtConfig } from './config';

export interface ComputeStackProps extends cdk.StackProps {
  readonly cfg: TtConfig;
  readonly vpc: ec2.IVpc;
  readonly appSg: ec2.ISecurityGroup;
}

export class ComputeStack extends cdk.Stack {
  // Real ALB DNS is assigned in a later task once the ALB is created;
  // placeholder here keeps synth green and the EdgeStack wiring typed.
  public readonly albDnsName: string;

  public readonly gwRepo: ecr.Repository;
  public readonly msgsvcRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    this.albDnsName = '';  // Task 6 will replace with the real ALB DNS.

    this.gwRepo = new ecr.Repository(this, 'GatewayRepo', {
      repositoryName: 'tt-gw',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,   // we rebuild from source; repos are disposable
      emptyOnDelete: true,
    });
    this.msgsvcRepo = new ecr.Repository(this, 'MsgsvcRepo', {
      repositoryName: 'tt-msgsvc',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
