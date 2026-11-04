'use strict';

const path = require('path');
const fs = require('fs');
const { runHttpCheck, runHealthCheck } = require('./checks');
const { judgeApp, recordRun, buildPublic } = require('./evaluate');
const { mergeLocations } = require('./locations');
const { probeChina } = require('./globalping');

const STATE_KEY = 'state.json';
const PUBLIC_KEY = 'data/status.json';
const PROBE_FUNCTION = 'dliu-status-probe';

function loadConfig() {
  // Deployed next to this file by the stack; read from the repo when run locally.
  const deployed = path.join(__dirname, 'apps.json');
  const file = fs.existsSync(deployed) ? deployed : path.join(__dirname, '..', '..', 'config', 'apps.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Sites run a few at a time and each site's checks one after another. Firing every request at once made the small
// Lambda's TLS handshakes queue, which showed up as false "slow" results (and sites asked for sequential requests).
const SITES_AT_ONCE = 4;

async function probeApp(app, defaults, options) {
  const functions = {};
  for (const fn of app.functions) {
    functions[fn.key] = [];
    for (const check of fn.checks) functions[fn.key].push(await runHttpCheck(check, defaults, options));
  }
  const health = app.health ? await runHealthCheck(new URL('/health', app.url).href, defaults, options) : null;
  return { functions, health };
}

// Runs every check from where this code runs, without judging: { [appKey]: { functions, health } }.
async function probeAll(config, options = {}) {
  const raw = {};
  let next = 0;
  const worker = async () => {
    while (next < config.apps.length) {
      const app = config.apps[next++];
      raw[app.key] = await probeApp(app, config.defaults, options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SITES_AT_ONCE, config.apps.length) }, worker));
  return raw;
}

function judgeAll(config, merged, previousStreaks = {}) {
  return config.apps.map((app) => judgeApp(app, merged[app.key].functions, merged[app.key].health, previousStreaks[app.key] || {}, config.defaults));
}

// One location only (used by scripts/check-now.js).
async function runChecks(config, previousStreaks = {}, options = {}) {
  const location = { key: 'local', name: 'here' };
  const merged = mergeLocations(config.apps, [{ location, raw: await probeAll(config, options) }]);
  return judgeAll(config, merged, previousStreaks);
}

// Remote locations run the same checks in their own region and return the raw results.
async function invokeProbe(location) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const client = new LambdaClient({ region: location.region });
  try {
    const response = await client.send(new InvokeCommand({ FunctionName: PROBE_FUNCTION, InvocationType: 'RequestResponse' }));
    if (response.FunctionError) throw new Error(response.FunctionError);
    return JSON.parse(Buffer.from(response.Payload).toString('utf8')).raw;
  } catch (error) {
    console.error(JSON.stringify({ probe: location.key, error: error.message }));
    return null;
  }
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

// Probe in Virginia and Tokyo: run the checks here and hand back the raw results.
exports.probe = async () => ({ raw: await probeAll(loadConfig()) });

// China's last results, reused until its next run (it runs hourly), so a China-only problem doesn't come and go.
async function chinaResults(config, state, now, options) {
  const location = config.locations.find((l) => l.provider === 'globalping');
  if (!location) return { china: null, raw: null };
  const every = location.everyMinutes * 60000;
  const last = state.china;
  // A few minutes' slack, so the run nearest each hour mark always qualifies.
  if (last && now - Date.parse(last.at) < every - 5 * 60000) return { location, china: last, raw: last.raw };
  try {
    const raw = await probeChina(config, location, options);
    const china = { at: new Date(now).toISOString(), raw };
    return { location, china, raw };
  } catch (error) {
    console.error(JSON.stringify({ probe: location.key, error: error.message }));
    // Keep the last results for one more period, then show China as not checked.
    const usable = last && now - Date.parse(last.at) < 2 * every;
    return { location, china: usable ? last : null, raw: usable ? last.raw : null };
  }
}

// Ireland: run the checks here, collect the other locations, merge, judge and publish.
exports.handler = async () => {
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  const config = loadConfig();
  const [home, ...remote] = config.locations.filter((l) => l.region);
  const state = await readState(s3, GetObjectCommand, process.env.STATE_BUCKET);
  const started = Date.now();
  const [china, ...raws] = await Promise.all([
    chinaResults(config, state, started),
    probeAll(config).then((raw) => ({ location: home, raw })),
    ...remote.map((location) => invokeProbe(location).then((raw) => ({ location, raw }))),
  ]);
  if (china.location) raws.push({ location: china.location, raw: china.raw });
  const results = judgeAll(config, mergeLocations(config.apps, raws), state.streaks || {});
  const now = Date.now();
  const next = recordRun(state, results, now);
  next.china = china.china || undefined;
  const view = buildPublic(config, next, results, now);
  view.locations = raws.map(({ location, raw }) => ({
    key: location.key,
    name: location.name,
    ran: Boolean(raw),
    ...(location.everyMinutes ? { everyMinutes: location.everyMinutes, at: china.china?.at } : {}),
  }));
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
  const ran = view.locations.filter((l) => l.ran).map((l) => l.key).join(',');
  console.log(JSON.stringify({ status: view.status, locations: ran, summary }));
  return { status: view.status, locations: ran, summary };
};

exports.runChecks = runChecks;
exports.chinaResults = chinaResults;
exports.probeAll = probeAll;
exports.loadConfig = loadConfig;
exports.PROBE_FUNCTION = PROBE_FUNCTION;
