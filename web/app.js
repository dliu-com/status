'use strict';

const { t, locale, name, joinNames, detail } = window.dlI18n;
const LABELS = { up: t('正常', 'Up'), degraded: t('降级', 'Degraded'), down: t('故障', 'Down') };
const CHECK_LABELS = { pass: t('通过', 'Pass'), warn: t('慢或部分正常', 'Slow or partly working'), fail: t('失败', 'Fail') };
const REFRESH_MS = 60 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return t('刚刚', 'just now');
  if (minutes < 60) return t(`${minutes} 分钟前`, `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t(`${hours} 小时前`, `${hours} h ago`);
  return t(`${Math.round(hours / 24)} 天前`, `${Math.round(hours / 24)} days ago`);
}

// Times are shown in the visitor's own time zone, with its name (e.g. "4 Nov 2026, 00:30 GMT").
const when = (iso) => new Date(iso).toLocaleString(locale, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});
const percent = (value) => (value == null ? t('无数据', 'no data') : `${value.toFixed(value === 100 ? 0 : 2)} %`);

function pill(status) {
  return el('span', `pill pill-${status}`, LABELS[status] || status);
}

function dayBar(day) {
  const total = day.up + day.degraded + day.down;
  let tone = 'none';
  if (total) tone = day.down ? 'down' : day.degraded ? 'degraded' : 'up';
  const bar = el('span', `bar bar-${tone}`);
  const available = total && percent(((total - day.down) / total) * 100);
  bar.title = total
    ? t(`${day.date}：可用率 ${available}（共 ${total} 次检查，故障 ${day.down} 次，降级 ${day.degraded} 次）`,
      `${day.date}: ${available} available (${day.down} down, ${day.degraded} degraded of ${total} checks)`)
    : t(`${day.date}：无数据`, `${day.date}: no data`);
  return bar;
}

function renderFunction(fn, locations) {
  const item = el('li', 'fn');
  const head = el('div', 'fn-head');
  head.append(el('span', `dot dot-${fn.status}`), el('strong', null, name(fn.name)));
  if (!fn.critical) head.append(el('span', 'dl-muted fn-optional', t('可选', 'optional')));
  head.append(el('span', 'dl-muted fn-detail', detail(fn.detail)));
  item.append(head);
  const details = el('details', 'checks');
  details.append(el('summary', null, t(`${fn.checks.length} 项检查`, `${fn.checks.length} ${fn.checks.length === 1 ? 'check' : 'checks'}`)));
  const list = el('ul');
  for (const check of fn.checks) {
    const row = el('li');
    row.append(el('span', `dot dot-${check.status === 'pass' ? 'up' : check.status === 'warn' ? 'degraded' : 'down'}`));
    row.append(el('code', null, check.name), ' ', el('span', 'dl-muted', `${CHECK_LABELS[check.status]}${t('：', ': ')}${detail(check.detail)}`));
    if (check.locations && locations.length > 1) {
      const where = el('span', 'locations');
      for (const location of locations) {
        const result = check.locations[location.key];
        // Hourly locations (China) only run a few checks; leave them out where they didn't.
        if (!result && location.everyMinutes) continue;
        const tone = !result ? 'none' : result.status === 'pass' ? 'up' : result.status === 'warn' ? 'degraded' : 'down';
        const item = el('span', 'location');
        const place = name(location.name);
        item.title = result ? `${place}${t('：', ': ')}${detail(result.detail)}` : t(`${place}：未运行`, `${place}: did not run`);
        item.append(el('span', `dot dot-${tone}`), ` ${place}${result && result.status !== 'fail' ? ` ${result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}` : ''}`);
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
  const link = el('a', null, name(app.name));
  link.href = app.url;
  title.append(link);
  head.append(el('span', `dot dot-${app.status}`), title, pill(app.status));
  head.append(el('span', 'dl-muted app-uptime', t(`90 天可用率 ${percent(app.uptime.d90)}`, `${percent(app.uptime.d90)} over 90 days`)));
  card.append(head);
  card.append(el('p', 'dl-muted app-detail', app.status === 'up' ? t('所有功能正常', 'All functions working') : detail(app.detail)));

  const bars = el('div', 'bars');
  bars.setAttribute('role', 'img');
  bars.setAttribute('aria-label', t(`过去 90 天：可用率 ${percent(app.uptime.d90)}`, `Last 90 days: ${percent(app.uptime.d90)} available`));
  for (const day of app.days) bars.append(dayBar(day));
  card.append(bars);
  const scale = el('div', 'bars-scale dl-muted');
  scale.append(
    el('span', null, t('90 天前', '90 days ago')),
    el('span', null, t(`24 小时：${percent(app.uptime.d1)} · 7 天：${percent(app.uptime.d7)}`, `24 h: ${percent(app.uptime.d1)} · 7 days: ${percent(app.uptime.d7)}`)),
    el('span', null, t('今天', 'Today')),
  );
  card.append(scale);

  const functions = el('details', 'functions');
  functions.open = app.status !== 'up';
  const working = app.functions.filter((f) => f.status === 'up').length;
  functions.append(el('summary', null, t(`${app.functions.length} 个功能 · ${working} 个正常`, `${app.functions.length} functions · ${working} working`)));
  const list = el('ul', 'fn-list');
  for (const fn of app.functions) list.append(renderFunction(fn, locations));
  functions.append(list);
  const docs = el('a', 'how-tested', t('这个网站如何测试', 'How this site is tested'));
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
    const cell = el('td', 'dl-muted', t('暂无变化。', 'No changes yet.'));
    cell.colSpan = 4;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const incident of incidents.slice(0, 20)) {
    const row = el('tr');
    const change = el('td');
    change.append(pill(incident.from), ' → ', pill(incident.to));
    row.append(el('td', null, when(incident.at)), el('td', null, name(incident.name)), change, el('td', 'dl-muted', incident.to === 'up' ? t('已恢复', 'Working again') : detail(incident.detail)));
    body.append(row);
  }
}

function renderOverall(data) {
  const text = document.getElementById('overall-text');
  const meta = document.getElementById('overall-meta');
  const down = data.apps.filter((a) => a.status === 'down').length;
  const degraded = data.apps.filter((a) => a.status === 'degraded').length;
  const overall = document.getElementById('overall');
  overall.className = `overall overall-${data.status}`;
  if (data.status === 'up') text.textContent = t('所有网站运行正常', 'All sites are working');
  else if (down) {
    text.textContent = t(`${down} 个网站故障${degraded ? `，${degraded} 个降级` : ''}`,
      `${down} ${down === 1 ? 'site is' : 'sites are'} down${degraded ? `, ${degraded} degraded` : ''}`);
  } else text.textContent = t(`${degraded} 个网站有问题`, `${degraded} ${degraded === 1 ? 'site has' : 'sites have'} a problem`);
  const stale = Date.now() - Date.parse(data.generatedAt) > (data.intervalMinutes * 2 + 5) * 60000;
  const locations = data.locations || [];
  const places = joinNames(locations.map((l) => (l.everyMinutes ? `${name(l.name)}${t('（每小时）', ' (hourly)')}` : name(l.name))));
  meta.textContent = t(
    `以访客身份${places ? `从${places}` : ''}每 ${data.intervalMinutes} 分钟检查一次 · 上次检查：${ago(data.generatedAt)}（${when(data.generatedAt)}）`,
    `Checked every ${data.intervalMinutes} minutes as a guest${places ? ` from ${places}` : ''} · last check ${ago(data.generatedAt)} (${when(data.generatedAt)})`,
  );
  const missing = locations.filter((l) => !l.ran);
  if (missing.length) {
    const who = joinNames(missing.map((l) => name(l.name)));
    meta.append(el('span', null, t(` · ${who}本次未能检查`, ` · ${who} couldn't check this time`)));
  }
  if (stale) meta.append(el('strong', 'dl-error', t(' · 检查程序已停止，结果可能已过时', ' · the checker has stopped, so this may be out of date')));
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
    document.getElementById('overall-text').textContent = t('无法载入状态数据，请稍后再试。', 'The status data could not be loaded. Try again in a minute.');
  }
}

load();
setInterval(load, REFRESH_MS);
