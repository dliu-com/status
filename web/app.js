'use strict';

const LABELS = { up: 'Up', degraded: 'Degraded', down: 'Down' };
const CHECK_LABELS = { pass: 'Pass', warn: 'Slow or partly working', fail: 'Fail' };
const REFRESH_MS = 60 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const percent = (value) => (value == null ? 'no data' : `${value.toFixed(value === 100 ? 0 : 2)} %`);

function pill(status) {
  return el('span', `pill pill-${status}`, LABELS[status] || status);
}

function dayBar(day) {
  const total = day.up + day.degraded + day.down;
  let tone = 'none';
  if (total) tone = day.down ? 'down' : day.degraded ? 'degraded' : 'up';
  const bar = el('span', `bar bar-${tone}`);
  bar.title = total
    ? `${day.date}: ${percent(((total - day.down) / total) * 100)} available (${day.down} down, ${day.degraded} degraded of ${total} checks)`
    : `${day.date}: no data`;
  return bar;
}

function renderFunction(fn, locations) {
  const item = el('li', 'fn');
  const head = el('div', 'fn-head');
  head.append(el('span', `dot dot-${fn.status}`), el('strong', null, fn.name));
  if (!fn.critical) head.append(el('span', 'dl-muted fn-optional', 'optional'));
  head.append(el('span', 'dl-muted fn-detail', fn.detail));
  item.append(head);
  const details = el('details', 'checks');
  details.append(el('summary', null, `${fn.checks.length} ${fn.checks.length === 1 ? 'check' : 'checks'}`));
  const list = el('ul');
  for (const check of fn.checks) {
    const row = el('li');
    row.append(el('span', `dot dot-${check.status === 'pass' ? 'up' : check.status === 'warn' ? 'degraded' : 'down'}`));
    row.append(el('code', null, check.name), ' ', el('span', 'dl-muted', `${CHECK_LABELS[check.status]}: ${check.detail}`));
    if (check.locations && locations.length > 1) {
      const where = el('span', 'locations');
      for (const location of locations) {
        const result = check.locations[location.key];
        const tone = !result ? 'none' : result.status === 'pass' ? 'up' : result.status === 'warn' ? 'degraded' : 'down';
        const item = el('span', 'location');
        item.title = result ? `${location.name}: ${result.detail}` : `${location.name}: did not run`;
        item.append(el('span', `dot dot-${tone}`), ` ${location.name}${result && result.status !== 'fail' ? ` ${result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}` : ''}`);
        where.append(item);
      }
      row.append(where);
    }
    list.append(row);
  }
  details.append(list);
  item.append(details);
  return item;
}

function renderApp(app, locations) {
  const card = el('article', `dl-card app app-${app.status}`);
  const head = el('div', 'app-head');
  const title = el('h2');
  const link = el('a', null, app.name);
  link.href = app.url;
  title.append(link);
  head.append(el('span', `dot dot-${app.status}`), title, pill(app.status));
  head.append(el('span', 'dl-muted app-uptime', `${percent(app.uptime.d90)} over 90 days`));
  card.append(head);
  card.append(el('p', 'dl-muted app-detail', app.status === 'up' ? 'All functions working' : app.detail));

  const bars = el('div', 'bars');
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', `Last 90 days: ${percent(app.uptime.d90)} available`);
  for (const day of app.days) bars.append(dayBar(day));
  card.append(bars);
  const scale = el('div', 'bars-scale dl-muted');
  scale.append(el('span', null, '90 days ago'), el('span', null, `24 h: ${percent(app.uptime.d1)} · 7 days: ${percent(app.uptime.d7)}`), el('span', null, 'Today'));
  card.append(scale);

  const functions = el('details', 'functions');
  functions.open = app.status !== 'up';
  const working = app.functions.filter((f) => f.status === 'up').length;
  functions.append(el('summary', null, `${app.functions.length} functions · ${working} working`));
  const list = el('ul', 'fn-list');
  for (const fn of app.functions) list.append(renderFunction(fn, locations));
  functions.append(list);
  const docs = el('a', 'how-tested', 'How this site is tested');
  docs.href = app.docs;
  functions.append(docs);
  card.append(functions);
  return card;
}

function renderIncidents(incidents) {
  const body = document.getElementById('incidents');
  body.replaceChildren();
  if (!incidents.length) {
    const row = el('tr');
    const cell = el('td', 'dl-muted', 'No changes yet.');
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const incident of incidents.slice(0, 20)) {
    const row = el('tr');
    const change = el('td');
    change.append(pill(incident.from), ' → ', pill(incident.to));
    row.append(el('td', null, when(incident.at)), el('td', null, incident.name), change, el('td', 'dl-muted', incident.to === 'up' ? 'Working again' : incident.detail));
    body.append(row);
  }
}

function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function renderOverall(data) {
  const text = document.getElementById('overall-text');
  const meta = document.getElementById('overall-meta');
  const down = data.apps.filter((a) => a.status === 'down').length;
  const degraded = data.apps.filter((a) => a.status === 'degraded').length;
  const overall = document.getElementById('overall');
  overall.className = `overall overall-${data.status}`;
  if (data.status === 'up') text.textContent = 'All sites are working';
  else if (down) text.textContent = `${down} ${down === 1 ? 'site is' : 'sites are'} down${degraded ? `, ${degraded} degraded` : ''}`;
  else text.textContent = `${degraded} ${degraded === 1 ? 'site has' : 'sites have'} a problem`;
  const stale = Date.now() - Date.parse(data.generatedAt) > (data.intervalMinutes * 2 + 5) * 60000;
  const locations = data.locations || [];
  const from = locations.length ? ` from ${listNames(locations.map((l) => l.name))}` : '';
  meta.textContent = `Checked every ${data.intervalMinutes} minutes as a guest${from} · last check ${ago(data.generatedAt)}`;
  const missing = locations.filter((l) => !l.ran);
  if (missing.length) meta.append(el('span', null, ` · ${listNames(missing.map((l) => l.name))} couldn't check this time`));
  if (stale) meta.append(el('strong', 'dl-error', ' · the checker has stopped, so this may be out of date'));
}

async function load() {
  try {
    const response = await fetch('/data/status.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderOverall(data);
    const apps = document.getElementById('apps');
    const open = new Set([...apps.querySelectorAll('details[open]')].map((d) => d.closest('[data-key]')?.dataset.key));
    apps.replaceChildren(...data.apps.map((app) => {
      const card = renderApp(app, data.locations || []);
      card.dataset.key = app.key;
      if (open.has(app.key)) card.querySelector('details.functions').open = true;
      return card;
    }));
    renderIncidents(data.incidents);
  } catch {
    document.getElementById('overall-text').textContent = 'The status data could not be loaded. Try again in a minute.';
  }
}

load();
setInterval(load, REFRESH_MS);
