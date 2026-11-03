#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { StatusStack } from '../lib/status-stack';
import { ProbeStack } from '../lib/probe-stack';
import { LOCATIONS } from '../lib/checker-code';

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
const account = process.env.CDK_DEFAULT_ACCOUNT;
// Imports the DNS and TrafficMonitor exports, which live in eu-west-1.
if (region !== 'eu-west-1') throw new Error('Status must be deployed to eu-west-1, alongside the other site stacks.');
if (LOCATIONS[0].region !== region) throw new Error('The first location in config/apps.json must be eu-west-1 (the checker).');

const app = new App();
const status = new StatusStack(app, 'Status', {
  locations: LOCATIONS,
  trafficLogging: app.node.tryGetContext('trafficLogging') !== 'false',
  tags: { service: 'status' },
  env: { account, region },
});
// One probe per other location, deployed before the checker that calls it.
for (const location of LOCATIONS.slice(1)) {
  const probe = new ProbeStack(app, `StatusProbe-${location.key}`, {
    description: `status.dliu.com guest checks from ${location.name}`,
    tags: { service: 'status' },
    env: { account, region: location.region },
  });
  status.addDependency(probe);
}
