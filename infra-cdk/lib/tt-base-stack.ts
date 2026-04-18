import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Placeholder stack. Has no resources — exists only so `cdk synth` succeeds
 * on the initial scaffold. Remove or replace when real stacks (vpc-stack,
 * data-stack, …) are added in subsequent tasks.
 */
export class TtBaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
