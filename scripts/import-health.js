#!/usr/bin/env node
// Reads a site's /docs/health.md (HEALTH.md format) and writes its functions and guest checks into config/apps.json.
// Usage: node scripts/import-health.js <app key> [<url of health.md>]
// Review the diff afterwards: rules a table can't express (e.g. "configured=true") need editing by hand.
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'config', 'apps.json');

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const unquote = (text) => text.replace(/^`|`$/g, '').trim();
const empty = (text) => !text || ['—', '-', '–', 'n/a'].includes(text.trim().toLowerCase());

function table(markdown, heading) {
  const start = markdown.search(new RegExp(`^##\\s+${heading}`, 'mi'));
  if (start < 0) return [];
  const lines = markdown.slice(start).split('\n').slice(1);
  const rows = [];
  let header = null;
  for (const line of lines) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith('|')) {
      if (header && rows.length) break;
      continue;
    }
    const row = cells(line);
    if (row.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (!header) header = row.map((h) => h.toLowerCase());
    else rows.push(Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));
  }
  return rows;
}

const column = (row, ...names) => {
  const key = Object.keys(row).find((k) => names.some((n) => k.includes(n)));
  return key ? row[key] : '';
};

function parseExpectation(text, status) {
  const expect = {};
  const code = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).find((c) => c.toLowerCase() !== 'location');
  if (empty(text) || !code) return expect;
  if (/location/i.test(text) || (status >= 300 && status < 400)) expect.location = code;
  else if (/json key/i.test(text)) expect.json = code;
  else expect.contains = code;
  return expect;
}

function parse(markdown, host) {
  const functions = table(markdown, 'Functions').map((row) => {
    const critical = column(row, 'critical');
    return {
      key: unquote(column(row, 'key')),
      name: unquote(column(row, 'name')),
      ...(/^no/i.test(critical) ? { critical: false } : {}),
      checks: [],
    };
  });
  for (const row of table(markdown, 'Guest checks')) {
    const method = unquote(column(row, 'method')).toUpperCase();
    const url = unquote(column(row, 'url'));
    const status = Number(unquote(column(row, 'status')));
    const type = unquote(column(row, 'content type', 'media type'));
    const slow = column(row, 'slow');
    const check = { url: url.startsWith('/') ? `https://${host}${url}` : url };
    if (method && method !== 'GET') check.method = method;
    check.expect = { status, ...(empty(type) ? {} : { type }), ...parseExpectation(column(row, 'marker', 'body', 'rule'), status) };
    if (!empty(slow) && /\d/.test(slow)) check.slowMs = Number(slow.replace(/[^\d]/g, ''));
    for (const key of unquote(column(row, 'function')).split(/,\s*/).map(unquote)) {
      const fn = functions.find((f) => f.key === key);
      if (!fn) throw new Error(`Guest check for unknown function "${key}"`);
      fn.checks.push(check);
      break; // a check listed for several functions (e.g. "game, rules" on /health) runs once, under the first
    }
  }
  const healthSection = markdown.slice(markdown.search(/^##\s+Health endpoint/mi));
  const health = /GET\s+`?https:\/\/[^\s`]+\/health`?/i.test(healthSection.split(/\n##\s/)[0]);
  // /health itself is read by the checker when health is true, so it isn't also a guest check.
  for (const fn of functions) fn.checks = fn.checks.filter((c) => !(health && new URL(c.url).pathname === '/health'));
  return { health, functions };
}

async function main() {
  const [key, source] = process.argv.slice(2);
  if (!key) throw new Error('Usage: node scripts/import-health.js <app key> [<health.md URL>]');
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const app = config.apps.find((a) => a.key === key);
  if (!app) throw new Error(`No app "${key}" in config/apps.json`);
  const url = source || `${app.url}docs/health.md`;
  const response = await fetch(url, { headers: { 'user-agent': 'dliu-status-bot/1.0 (+https://status.dliu.com/docs)' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const { health, functions } = parse(await response.text(), new URL(app.url).host);
  app.health = health;
  app.functions = functions;
  fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`${key}: health ${health}; ${functions.map((f) => `${f.key}(${f.checks.length})`).join(' ')}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });
module.exports = { parse };
