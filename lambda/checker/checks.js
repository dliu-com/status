'use strict';

// Every probe identifies itself, so traffic.dliu.com can drop it (see HEALTH.md).
const USER_AGENT = 'dliu-status-bot/1.0 (+https://status.dliu.com/docs)';
const MAX_BODY = 512 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function expectedStatuses(expect) {
  const status = expect.status ?? 200;
  return Array.isArray(status) ? status : [status];
}

function checkName(check) {
  if (check.name) return check.name;
  const url = new URL(check.url);
  const scheme = url.protocol === 'http:' ? `http://${url.host}` : '';
  return `${check.method || 'GET'} ${scheme}${url.pathname}${url.search} → ${expectedStatuses(check.expect || {}).join('/')}`;
}

async function readBody(response) {
  const text = await response.text();
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
}

function seconds(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// One request, judged against check.expect. Never sends cookies or credentials.
async function requestOnce(check, defaults, fetchImpl) {
  const expect = check.expect || {};
  const timeoutMs = check.timeoutMs ?? defaults.timeoutMs;
  const slowMs = check.slowMs ?? defaults.slowMs;
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(check.url, {
      method: check.method || 'GET',
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: expect.accept || '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { status: 'fail', detail: timedOut ? `No answer within ${seconds(timeoutMs)}` : 'Could not connect', ms: Date.now() - started };
  }
  const fail = (detail) => ({ status: 'fail', detail, ms: Date.now() - started });

  if (!expectedStatuses(expect).includes(response.status)) return fail(`HTTP ${response.status}, expected ${expectedStatuses(expect).join(' or ')}`);
  const type = response.headers.get('content-type') || '';
  if (expect.type && !type.toLowerCase().startsWith(expect.type.toLowerCase())) return fail(`Content type ${type || 'missing'}, expected ${expect.type}`);
  if (expect.location) {
    const location = response.headers.get('location') || '';
    if (!location.startsWith(expect.location)) return fail(`Redirects to ${location ? new URL(location, check.url).origin : 'nowhere'}, expected ${new URL(expect.location).origin}`);
  }
  if (expect.contains || expect.json || expect.jsonEquals || expect.jsonPattern) {
    let body;
    try {
      body = await readBody(response);
    } catch {
      return fail('Body could not be read');
    }
    if (expect.contains && !body.includes(expect.contains)) return fail('Page content is missing its marker');
    if (expect.json || expect.jsonEquals || expect.jsonPattern) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return fail('Answer is not JSON');
      }
      if (!parsed || typeof parsed !== 'object') return fail('Answer is not a JSON object');
      if (expect.json && !(expect.json in parsed)) return fail(`JSON has no "${expect.json}"`);
      for (const [key, value] of Object.entries(expect.jsonEquals || {})) {
        if (parsed[key] !== value) return fail(`JSON "${key}" is not ${JSON.stringify(value)}`);
      }
      // Values are never echoed: some are identifiers the site asks not to log.
      for (const [key, pattern] of Object.entries(expect.jsonPattern || {})) {
        if (typeof parsed[key] !== 'string' || !new RegExp(pattern).test(parsed[key])) return fail(`JSON "${key}" is missing or malformed`);
      }
    }
  } else if (response.body) {
    await response.body.cancel().catch(() => {});
  }
  const ms = Date.now() - started;
  if (ms > slowMs) return { status: 'warn', detail: `Slow: ${seconds(ms)}`, ms };
  return { status: 'pass', detail: `HTTP ${response.status} in ${seconds(ms)}`, ms };
}

// A failed check is tried once more in the same run, so one dropped packet doesn't count.
async function runHttpCheck(check, defaults, { fetchImpl = fetch, retryDelayMs = 2000 } = {}) {
  const first = await requestOnce(check, defaults, fetchImpl);
  if (first.status !== 'fail') return { name: checkName(check), ...first };
  await sleep(retryDelayMs);
  const second = await requestOnce(check, defaults, fetchImpl);
  if (second.status !== 'fail') return { name: checkName(check), ...second, detail: `${second.detail} (passed on retry)` };
  return { name: checkName(check), ...second };
}

const HEALTH_STATUSES = new Set(['pass', 'warn', 'fail']);

// Reads a /health answer (HEALTH.md format) into its functions, or an error saying what's wrong with it.
function parseHealthBody(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: '/health did not return JSON' };
  }
  if (!body || !HEALTH_STATUSES.has(body.status) || !Array.isArray(body.functions)) {
    return { error: '/health answer is not in the agreed format' };
  }
  return {
    functions: body.functions
      .filter((fn) => fn && typeof fn.key === 'string' && HEALTH_STATUSES.has(fn.status))
      .map((fn) => ({
        key: fn.key,
        name: typeof fn.name === 'string' ? fn.name.slice(0, 80) : fn.key,
        status: fn.status,
        output: typeof fn.output === 'string' ? fn.output.slice(0, 120) : '',
      })),
  };
}

// GET <site>/health (HEALTH.md). Returns the endpoint's own result and the functions it reports.
async function runHealthCheck(url, defaults, { fetchImpl = fetch, retryDelayMs = 2000 } = {}) {
  const attempt = async () => {
    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: 'application/health+json, application/json' },
        signal: AbortSignal.timeout(defaults.timeoutMs),
      });
    } catch {
      return { status: 'fail', detail: 'No answer from /health', ms: Date.now() - started, functions: [] };
    }
    const ms = Date.now() - started;
    if (![200, 503].includes(response.status)) return { status: 'fail', detail: `/health answered HTTP ${response.status}`, ms, functions: [] };
    let text;
    try {
      text = await readBody(response);
    } catch {
      return { status: 'fail', detail: '/health did not return JSON', ms, functions: [] };
    }
    const parsed = parseHealthBody(text);
    if (parsed.error) return { status: 'fail', detail: parsed.error, ms, functions: [] };
    const { functions } = parsed;
    const slow = ms > defaults.slowMs;
    return { status: slow ? 'warn' : 'pass', detail: slow ? `Slow: ${seconds(ms)}` : `Answered in ${seconds(ms)}`, ms, functions };
  };
  const first = await attempt();
  if (first.status !== 'fail') return first;
  await sleep(retryDelayMs);
  return attempt();
}

module.exports = { USER_AGENT, checkName, runHttpCheck, runHealthCheck, parseHealthBody, seconds };
