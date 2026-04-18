import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    this.albDnsName = '';  // Task 6 will replace with the real ALB DNS.
  }
}
