'use strict';

const TABS = ['architecture', 'checks', 'cost', 'security', 'health'];
// Old links: /docs#how was the first tab's name.
const ALIASES = { how: 'architecture' };
const STATUS_LABELS = { up: 'Up', degraded: 'Degraded', down: 'Down' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showTab() {
  const hash = ALIASES[location.hash.slice(1)] || location.hash.slice(1);
  const id = TABS.includes(hash) ? hash : 'architecture';
  for (const section of document.querySelectorAll('[data-section]')) section.hidden = section.id !== id;
  for (const link of document.querySelectorAll('.dl-tabs [data-tab]')) {
    if (link.dataset.tab === id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function loadChecks() {
  const target = document.getElementById('check-list');
  try {
    const response = await fetch('/data/status.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error();
    const data = await response.json();
    target.replaceChildren();
    for (const app of data.apps) {
      const heading = el('h3');
      const link = el('a', null, app.name);
      link.href = app.docs;
      heading.append(el('span', `dot dot-${app.status}`), ' ', link);
      target.append(heading);
      const wrap = el('div', 'dl-table-wrap');
      const table = el('table', 'dl-table');
      const head = el('tr');
      for (const title of ['Function', 'Check', 'Latest result']) head.append(el('th', null, title));
      table.append(el('thead'));
      table.tHead.append(head);
      const body = el('tbody');
      for (const fn of app.functions) {
        fn.checks.forEach((check, index) => {
          const row = el('tr');
          if (index === 0) {
            const cell = el('td', null, `${fn.name}${fn.critical ? '' : ' (optional)'}`);
            cell.rowSpan = fn.checks.length;
            row.append(cell);
          }
          const name = el('td');
          name.append(el('code', null, check.name));
          row.append(name, el('td', null, `${STATUS_LABELS[{ pass: 'up', warn: 'degraded', fail: 'down' }[check.status]]}: ${check.detail}`));
          body.append(row);
        });
      }
      table.append(body);
      wrap.append(table);
      target.append(wrap);
    }
  } catch {
    target.replaceChildren(el('p', 'dl-error', 'The checks could not be loaded. Try again in a minute.'));
  }
}

window.addEventListener('hashchange', showTab);
showTab();
loadChecks();
