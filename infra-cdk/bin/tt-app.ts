#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ttConfig } from '../lib/config';
import { VpcStack } from '../lib/vpc-stack';

const app = new cdk.App();
const env: cdk.Environment = { account: ttConfig.account, region: ttConfig.region };

const vpcStack = new VpcStack(app, 'TtVpcStack', { env, cfg: ttConfig });

app.synth();
