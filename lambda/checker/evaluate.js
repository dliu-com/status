'use strict';

// Turns check results into statuses, keeps the history and builds the public file. No I/O here.

const CHECK_RANK = { pass: 0, warn: 1, fail: 2 };
const STATUS_RANK = { up: 0, degraded: 1, down: 2 };
const CODES = { up: 'u', degraded: 'g', down: 'd' };
const HISTORY_DAYS = 90;
const RECENT_MS = 24 * 3600 * 1000;
const MAX_INCIDENTS = 100;

const worstCheck = (checks) => checks.reduce((worst, c) => (CHECK_RANK[c.status] > CHECK_RANK[worst] ? c.status : worst), 'pass');

// A function is down only after failing `failuresBeforeDown` runs in a row; until then it is degraded.
function judgeFunction(fn, checks, previousStreak, failuresBeforeDown) {
  const raw = worstCheck(checks);
  const streak = raw === 'fail' ? previousStreak + 1 : 0;
  const problem = checks.find((c) => c.status === raw && raw !== 'pass');
  let status = 'up';
  let detail = 'Working';
  if (raw === 'fail' && streak >= failuresBeforeDown) {
    status = 'down';
    detail = problem.detail;
  } else if (raw === 'fail') {
    status = 'degraded';
    detail = `${problem.detail}. Failed once; down if the next check fails too`;
  } else if (raw === 'warn') {
    status = 'degraded';
    detail = problem.detail;
  }
  return { key: fn.key, name: fn.name, critical: fn.critical !== false, status, detail, streak, checks };
}

// Merges the site's /health answer into its functions: same key → extra check, new key → new function.
function withHealth(app, functionResults, health) {
  const functions = app.functions.map((fn) => ({ fn, checks: [...(functionResults[fn.key] || [])] }));
  if (!health) {
    for (const f of functions) if (!f.checks.length) f.checks.push({ name: `Health: ${f.fn.name}`, status: 'fail', detail: '/health was not read' });
    return functions;
  }
  functions.push({
    fn: { key: 'health', name: 'Health endpoint', critical: true },
    checks: [{ name: 'GET /health', status: health.status, detail: health.detail, ms: health.ms }],
  });
  for (const reported of health.functions) {
    const check = {
      name: `Health: ${reported.name}`,
      status: reported.status,
      detail: reported.output || { pass: 'Reported working', warn: 'Reported slow or partly working', fail: 'Reported failing' }[reported.status],
    };
    const existing = functions.find((f) => f.fn.key === reported.key);
    if (existing) existing.checks.push(check);
    else functions.push({ fn: { key: reported.key, name: reported.name, critical: true }, checks: [check] });
  }
  // A function configured to come only from /health must not pass silently when /health stops reporting it.
  for (const f of functions) {
    if (!f.checks.length) f.checks.push({ name: `Health: ${f.fn.name}`, status: 'fail', detail: 'Not reported by /health' });
  }
  return functions;
}

function judgeApp(app, functionResults, health, previousStreaks, defaults) {
  const failuresBeforeDown = app.failuresBeforeDown ?? defaults.failuresBeforeDown;
  const streaks = {};
  const functions = withHealth(app, functionResults, health).map(({ fn, checks }) => {
    const judged = judgeFunction(fn, checks, previousStreaks[fn.key] || 0, failuresBeforeDown);
    streaks[fn.key] = judged.streak;
    return judged;
  });
  let status = 'up';
  if (functions.some((f) => f.critical && f.status === 'down')) status = 'down';
  else if (functions.some((f) => f.status !== 'up')) status = 'degraded';
  const notUp = functions.filter((f) => f.status !== 'up').map((f) => f.name);
  const detail = notUp.length ? `${notUp.join(', ')} ${notUp.length === 1 ? 'is' : 'are'} not working normally` : 'All functions working';
  return { key: app.key, status, detail, functions, streaks };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Updates state (streaks, current status, daily counts, last 24 h, incidents) with one run's results.
function recordRun(state, results, now) {
  const next = {
    version: 1,
    streaks: { ...(state.streaks || {}) },
    current: { ...(state.current || {}) },
    days: { ...(state.days || {}) },
    recent: { ...(state.recent || {}) },
    incidents: [...(state.incidents || [])],
    lastRun: new Date(now).toISOString(),
  };
  const today = dayOf(now);
  const oldestDay = dayOf(now - (HISTORY_DAYS - 1) * 86400000);
  for (const app of results) {
    next.streaks[app.key] = app.streaks;
    const before = next.current[app.key];
    if (!before || before.status !== app.status) {
      next.current[app.key] = { status: app.status, since: new Date(now).toISOString() };
      if (before) {
        next.incidents.unshift({ app: app.key, from: before.status, to: app.status, at: new Date(now).toISOString(), detail: app.detail });
      }
    }
    const days = { ...(next.days[app.key] || {}) };
    const counts = [...(days[today] || [0, 0, 0])];
    counts[STATUS_RANK[app.status]] += 1;
    days[today] = counts;
    for (const day of Object.keys(days)) if (day < oldestDay) delete days[day];
    next.days[app.key] = days;
    next.recent[app.key] = [...(next.recent[app.key] || []), [Math.floor(now / 1000), CODES[app.status]]]
      .filter(([t]) => t * 1000 > now - RECENT_MS);
  }
  next.incidents = next.incidents.slice(0, MAX_INCIDENTS);
  return next;
}

// Share of checks that were not down (degraded still counts as available).
function uptime(days, now, n) {
  let total = 0;
  let down = 0;
  for (let i = 0; i < n; i += 1) {
    const counts = days[dayOf(now - i * 86400000)];
    if (!counts) continue;
    total += counts[0] + counts[1] + counts[2];
    down += counts[2];
  }
  return total ? Math.round(((total - down) / total) * 10000) / 100 : null;
}

function overallStatus(apps) {
  if (apps.some((a) => a.status === 'down')) return 'down';
  if (apps.some((a) => a.status === 'degraded')) return 'degraded';
  return 'up';
}

// What status.dliu.com shows. Private apps (config "private": true) are left out entirely.
function buildPublic(config, state, results, now) {
  const publicApps = config.apps.filter((a) => !a.private);
  const publicKeys = new Set(publicApps.map((a) => a.key));
  const byKey = new Map(results.map((r) => [r.key, r]));
  const apps = publicApps.filter((a) => byKey.has(a.key)).map((app) => {
    const result = byKey.get(app.key);
    const days = state.days[app.key] || {};
    const history = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i -= 1) {
      const date = dayOf(now - i * 86400000);
      const [u, g, d] = days[date] || [0, 0, 0];
      history.push({ date, up: u, degraded: g, down: d });
    }
    return {
      key: app.key,
      name: app.name,
      url: app.url,
      docs: app.docs,
      status: result.status,
      detail: result.detail,
      since: state.current[app.key]?.since,
      uptime: { d1: uptime(days, now, 1), d7: uptime(days, now, 7), d30: uptime(days, now, 30), d90: uptime(days, now, 90) },
      days: history,
      recent: (state.recent[app.key] || []).map(([t, code]) => [t, code]),
      functions: result.functions.map((f) => ({
        key: f.key,
        name: f.name,
        critical: f.critical,
        status: f.status,
        detail: f.detail,
        checks: f.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail, ms: c.ms })),
      })),
    };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    intervalMinutes: config.intervalMinutes,
    status: overallStatus(apps),
    apps,
    incidents: state.incidents.filter((i) => publicKeys.has(i.app)).slice(0, 50).map((i) => ({
      ...i,
      name: publicApps.find((a) => a.key === i.app).name,
    })),
  };
}

module.exports = { judgeFunction, judgeApp, recordRun, uptime, buildPublic, overallStatus, HISTORY_DAYS };
