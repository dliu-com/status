#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { StatusStack } from '../lib/status-stack';

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
// Imports the DNS and TrafficMonitor exports, which live in eu-west-1.
if (region !== 'eu-west-1') throw new Error('Status must be deployed to eu-west-1, alongside the other site stacks.');

const app = new App();
new StatusStack(app, 'Status', {
  trafficLogging: app.node.tryGetContext('trafficLogging') !== 'false',
  tags: { service: 'status' },
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});
