#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ttConfig } from '../lib/config';
import { VpcStack } from '../lib/vpc-stack';
import { DataStack } from '../lib/data-stack';
import { BastionStack } from '../lib/bastion-stack';

const app = new cdk.App();
const env: cdk.Environment = { account: ttConfig.account, region: ttConfig.region };

const vpcStack  = new VpcStack(app, 'TtVpcStack', { env, cfg: ttConfig });
const dataStack = new DataStack(app, 'TtDataStack', { env, cfg: ttConfig, vpc: vpcStack.vpc });
dataStack.addDependency(vpcStack);

const bastionStack = new BastionStack(app, 'TtBastionStack', {
  env,
  vpc: vpcStack.vpc,
  appSg: dataStack.appSg,
});
bastionStack.addDependency(dataStack);

app.synth();
