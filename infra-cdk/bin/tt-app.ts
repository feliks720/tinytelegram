#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ttConfig } from '../lib/config';
import { TtBaseStack } from '../lib/tt-base-stack';

const app = new cdk.App();
const env: cdk.Environment = { account: ttConfig.account, region: ttConfig.region };

// TtBaseStack is a no-resource placeholder so `cdk synth` succeeds on the
// initial scaffold. Real stacks (vpc-stack, data-stack, …) will replace it
// in subsequent tasks.
new TtBaseStack(app, 'TtBaseStack', { env });

app.synth();
