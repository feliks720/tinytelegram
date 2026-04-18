import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TtConfig } from './config';

export interface EdgeStackProps extends cdk.StackProps {
  readonly cfg: TtConfig;
  readonly albDnsName: string;
}

export class EdgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
  }
}
