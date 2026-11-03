'use strict';

const { checkName } = require('./checks');

// Combines the same check run from several locations (Ireland, Virginia, Tokyo) into one result.
// - fail: most locations failed it (a real outage)
// - warn: some locations failed it ("only from Tokyo": one edge or region), or most found it slow
// - pass: otherwise
// Each merged result keeps every location's own result, so the page can show where it failed.

const median = (values) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

const names = (entries) => entries.map((e) => e.location.name).join(', ');
const seconds = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// entries: [{ location: { key, name }, result }], result missing when that location's probe didn't answer.
function mergeResults(entries, name) {
  const present = entries.filter((e) => e.result);
  const locations = Object.fromEntries(present.map((e) => [e.location.key, { status: e.result.status, detail: e.result.detail, ms: e.result.ms }]));
  if (!present.length) return { name, status: 'fail', detail: 'No location could run this check', locations };
  const fails = present.filter((e) => e.result.status === 'fail');
  const warns = present.filter((e) => e.result.status === 'warn');
  const ms = median(present.filter((e) => e.result.status !== 'fail').map((e) => e.result.ms));
  if (fails.length * 2 > present.length) {
    return { name, status: 'fail', detail: `${fails[0].result.detail} (from ${names(fails)})`, ms: median(fails.map((e) => e.result.ms)), locations };
  }
  if (fails.length) {
    return { name, status: 'warn', detail: `Fails from ${names(fails)} only: ${fails[0].result.detail}`, ms, locations };
  }
  if (warns.length * 2 > present.length) {
    return { name, status: 'warn', detail: `${warns[0].result.detail} (from ${names(warns)})`, ms, locations };
  }
  const from = present.length === entries.length ? `all ${present.length} locations` : names(present);
  return { name, status: 'pass', detail: `Passed from ${from}, median ${seconds(ms)}`, ms, locations };
}

// Merges each location's /health answer: the endpoint like any check, and each reported function by the same rule.
function mergeHealth(entries) {
  const present = entries.filter((e) => e.result);
  const endpoint = mergeResults(entries, 'GET /health');
  const keys = [];
  for (const e of present) for (const fn of e.result.functions) if (!keys.some((k) => k.key === fn.key)) keys.push({ key: fn.key, name: fn.name });
  const functions = keys.map(({ key, name }) => {
    const reports = present
      .map((e) => ({ location: e.location, fn: e.result.functions.find((f) => f.key === key) }))
      .filter((r) => r.fn);
    const failing = reports.filter((r) => r.fn.status === 'fail');
    const warning = reports.filter((r) => r.fn.status === 'warn');
    let status = 'pass';
    let output = '';
    if (failing.length * 2 > reports.length) {
      status = 'fail';
      output = failing[0].fn.output || 'Reported failing';
    } else if (failing.length || warning.length) {
      status = 'warn';
      const odd = failing.length ? failing : warning;
      output = `${odd[0].fn.output || (failing.length ? 'Reported failing' : 'Reported slow')} (from ${names(odd)} only)`;
    }
    return { key, name, status, output };
  });
  return { status: endpoint.status, detail: endpoint.detail, ms: endpoint.ms, locations: endpoint.locations, functions };
}

// raws: [{ location, raw }] where raw is { [appKey]: { functions: { [fnKey]: [result…] }, health } } or null.
// Returns the same shape as one location's raw, merged.
function mergeLocations(apps, raws) {
  const merged = {};
  for (const app of apps) {
    const functions = {};
    for (const fn of app.functions) {
      functions[fn.key] = fn.checks.map((check, index) => mergeResults(
        raws.map(({ location, raw }) => ({ location, result: raw?.[app.key]?.functions?.[fn.key]?.[index] })),
        checkName(check),
      ));
    }
    const health = app.health ? mergeHealth(raws.map(({ location, raw }) => ({ location, result: raw?.[app.key]?.health }))) : null;
    merged[app.key] = { functions, health };
  }
  return merged;
}

module.exports = { mergeResults, mergeHealth, mergeLocations, median };
