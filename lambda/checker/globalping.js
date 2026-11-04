'use strict';

// The China location: guest checks run by Globalping (https://globalping.io, by jsDelivr), whose volunteer probes include
// home and cloud networks in mainland China. No account: the free limit is 250 tests an hour per IP address, and
// Lambda's IP addresses are shared with other AWS customers, so China runs once an hour and only checks each site's
// home page and /health, from 2 probes (about 40 tests an hour). Probes send Globalping's own user agent
// ("globalping probe …"), which traffic.dliu.com drops like status's own.

const { checkName, parseHealthBody, seconds } = require('./checks');

const API = 'https://api.globalping.io/v1/measurements';
const CLIENT = 'dliu-status/1.0 (+https://status.dliu.com/docs)';
const POLL_MS = 1000;
const MAX_WAIT_MS = 40000;
const AT_ONCE = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The checks China runs: each site's home page check, plus /health for sites that have one.
function chinaChecks(config) {
  const checks = [];
  for (const app of config.apps) {
    for (const fn of app.functions) {
      const index = fn.checks.findIndex((c) => c.url === app.url && (c.method || 'GET') === 'GET');
      if (index >= 0) {
        checks.push({ app: app.key, fn: fn.key, index, check: fn.checks[index] });
        break;
      }
    }
    if (app.health) checks.push({ app: app.key, health: true, check: { url: new URL('/health', app.url).href } });
  }
  return checks;
}

class RateLimited extends Error {}

async function measure(check, location, fetchImpl) {
  const url = new URL(check.url);
  const response = await fetchImpl(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': CLIENT },
    body: JSON.stringify({
      type: 'http',
      target: url.hostname,
      locations: location.probes,
      limit: location.probes.length,
      measurementOptions: {
        protocol: url.protocol === 'http:' ? 'HTTP' : 'HTTPS',
        request: { method: check.method || 'GET', path: url.pathname, ...(url.search ? { query: url.search.slice(1) } : {}) },
      },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 429) throw new RateLimited('Globalping limit reached');
  if (!response.ok) throw new Error(`Globalping answered HTTP ${response.status}`);
  const { id } = await response.json();
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    const poll = await fetchImpl(`${API}/${id}`, { headers: { 'user-agent': CLIENT }, signal: AbortSignal.timeout(10000) });
    if (!poll.ok) continue;
    const measurement = await poll.json();
    // Each result is { probe, result }; flatten so judging reads one object.
    if (measurement.status !== 'in-progress') return (measurement.results || []).map((r) => ({ ...r.result, probe: r.probe }));
  }
  return [];
}

const header = (result, name) => {
  const value = result.headers?.[name];
  return Array.isArray(value) ? value[0] : value || '';
};

// One probe's answer judged against the check's expectations (only the first 10 KB of the body come back).
function judgeProbe(result, check, slowMs) {
  const where = `${result.probe?.city || '?'}, ${result.probe?.network || '?'}`;
  if (result.status !== 'finished') return { status: 'fail', detail: `No answer (${where})` };
  const expect = check.expect || {};
  const statuses = [].concat(expect.status ?? 200);
  const ms = result.timings?.total;
  if (!statuses.includes(result.statusCode)) return { status: 'fail', detail: `HTTP ${result.statusCode}, expected ${statuses.join(' or ')} (${where})`, ms };
  const type = header(result, 'content-type');
  if (expect.type && !type.toLowerCase().startsWith(expect.type.toLowerCase())) return { status: 'fail', detail: `Content type ${type || 'missing'} (${where})`, ms };
  if (expect.location && !header(result, 'location').startsWith(expect.location)) return { status: 'fail', detail: `Redirects elsewhere (${where})`, ms };
  const body = result.rawBody || '';
  if (expect.contains && !body.includes(expect.contains) && !result.truncated) return { status: 'fail', detail: `Page content is missing its marker (${where})`, ms };
  if (ms > slowMs) return { status: 'warn', detail: `Slow: ${seconds(ms)} (${where})`, ms };
  return { status: 'pass', detail: `HTTP ${result.statusCode} in ${seconds(ms)} (${where})`, ms };
}

// China as one location: failing only when every probe failed (one volunteer probe can be offline).
function combineProbes(judged, name) {
  if (!judged.length) return { name, status: 'fail', detail: 'No China probe answered' };
  const ok = judged.filter((j) => j.status !== 'fail');
  if (!ok.length) return { name, status: 'fail', detail: judged[0].detail, ms: judged[0].ms };
  const times = ok.map((j) => j.ms).sort((a, b) => a - b);
  const ms = times[Math.floor((times.length - 1) / 2)];
  const slow = ok.filter((j) => j.status === 'warn');
  if (slow.length === ok.length) return { name, status: 'warn', detail: slow[0].detail, ms };
  return { name, status: 'pass', detail: `${ok.length} of ${judged.length} China probes passed, median ${seconds(ms)}`, ms };
}

function healthFromProbes(results, slowMs) {
  const answers = results.filter((r) => r.status === 'finished' && [200, 503].includes(r.statusCode));
  const parsed = answers.map((r) => ({ r, h: parseHealthBody(r.rawBody || '') })).filter((a) => !a.h.error);
  if (!parsed.length) {
    const first = results[0];
    const detail = !first ? 'No China probe answered'
      : first.status !== 'finished' ? '/health: no answer' : answers.length ? '/health answer is not in the agreed format' : `/health answered HTTP ${first.statusCode}`;
    return { status: 'fail', detail, functions: [] };
  }
  const best = parsed.sort((a, b) => a.r.timings.total - b.r.timings.total)[0];
  const ms = best.r.timings.total;
  return {
    status: ms > slowMs ? 'warn' : 'pass',
    detail: `${ms > slowMs ? 'Slow: ' : 'Answered in '}${seconds(ms)} (${best.r.probe.city}, ${best.r.probe.network})`,
    ms,
    functions: best.h.functions,
  };
}

// Runs the China checks. Returns raw results in the same shape as the other locations (only the checks China ran are
// filled in), or throws when Globalping can't be used this time.
async function probeChina(config, location, { fetchImpl = fetch } = {}) {
  const slowMs = location.slowMs ?? config.defaults.slowMs;
  const raw = {};
  const queue = chinaChecks(config);
  let next = 0;
  let limited = null;
  const worker = async () => {
    while (next < queue.length && !limited) {
      const item = queue[next++];
      let results;
      try {
        results = await measure(item.check, location, fetchImpl);
      } catch (error) {
        if (error instanceof RateLimited) limited = error;
        continue;
      }
      raw[item.app] = raw[item.app] || { functions: {}, health: undefined };
      if (item.health) {
        raw[item.app].health = healthFromProbes(results, slowMs);
      } else {
        const list = raw[item.app].functions[item.fn] || [];
        list[item.index] = combineProbes(results.map((r) => judgeProbe(r, item.check, slowMs)), checkName(item.check));
        raw[item.app].functions[item.fn] = list;
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  if (limited && !Object.keys(raw).length) throw limited;
  return raw;
}

module.exports = { probeChina, chinaChecks, judgeProbe, combineProbes, healthFromProbes, RateLimited };
