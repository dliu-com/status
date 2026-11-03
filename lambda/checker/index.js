'use strict';

const path = require('path');
const fs = require('fs');
const { runHttpCheck, runHealthCheck } = require('./checks');
const { judgeApp, recordRun, buildPublic } = require('./evaluate');

const STATE_KEY = 'state.json';
const PUBLIC_KEY = 'data/status.json';

function loadConfig() {
  // Deployed next to this file by the stack; read from the repo when run locally.
  const deployed = path.join(__dirname, 'apps.json');
  const file = fs.existsSync(deployed) ? deployed : path.join(__dirname, '..', '..', 'config', 'apps.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Sites run a few at a time and each site's checks one after another. Firing every request at once made the small
// Lambda's TLS handshakes queue, which showed up as false "slow" results (and sites asked for sequential requests).
const SITES_AT_ONCE = 4;

async function checkApp(app, defaults, previousStreaks, options) {
  const functionResults = {};
  for (const fn of app.functions) {
    functionResults[fn.key] = [];
    for (const check of fn.checks) functionResults[fn.key].push(await runHttpCheck(check, defaults, options));
  }
  const health = app.health ? await runHealthCheck(new URL('/health', app.url).href, defaults, options) : null;
  return judgeApp(app, functionResults, health, previousStreaks, defaults);
}

async function runChecks(config, previousStreaks = {}, options = {}) {
  const results = new Array(config.apps.length);
  let next = 0;
  const worker = async () => {
    while (next < config.apps.length) {
      const index = next++;
      const app = config.apps[index];
      results[index] = await checkApp(app, config.defaults, previousStreaks[app.key] || {}, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SITES_AT_ONCE, config.apps.length) }, worker));
  return results;
}

async function readState(s3, GetObjectCommand, bucket) {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: STATE_KEY }));
    return JSON.parse(await object.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey') return {};
    throw error;
  }
}

exports.handler = async () => {
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  const config = loadConfig();
  const state = await readState(s3, GetObjectCommand, process.env.STATE_BUCKET);
  const results = await runChecks(config, state.streaks || {});
  const now = Date.now();
  const next = recordRun(state, results, now);
  const view = buildPublic(config, next, results, now);
  await s3.send(new PutObjectCommand({
    Bucket: process.env.STATE_BUCKET,
    Key: STATE_KEY,
    Body: JSON.stringify(next),
    ContentType: 'application/json',
  }));
  await s3.send(new PutObjectCommand({
    Bucket: process.env.SITE_BUCKET,
    Key: PUBLIC_KEY,
    Body: JSON.stringify(view),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'public, max-age=60',
  }));
  const summary = results.map((r) => `${r.key}:${r.status}`).join(' ');
  console.log(JSON.stringify({ status: view.status, summary }));
  return { status: view.status, summary };
};

exports.runChecks = runChecks;
exports.loadConfig = loadConfig;
