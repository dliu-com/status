const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8');
const DL_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css">';
const DL_DOCS_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl-docs.css">';
const DL_ICON = 'https://files.dliu.com/dliu.com/favicon.png';
const PAGES = ['index.html', '404.html', 'docs/index.html'];

test('every page loads the shared stylesheet before its own and has the shared header and footer', () => {
  for (const file of PAGES) {
    const page = read(file);
    expect(page).toContain(DL_CSS);
    expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf('<link rel="stylesheet" href="/style.css">'));
    expect(page).toContain('<link rel="icon" href="/logo.svg" type="image/svg+xml">');
    expect(page).toContain('<body class="dl-page">');
    expect(page).toContain('<a class="dl-brand" href="/"><img class="dl-logo" src="/logo.svg" alt="" width="32" height="32">DL status</a>');
    expect(page).toMatch(/<main class="dl-main[" ]/);
    expect(page).toMatch(new RegExp(`<footer class="dl-footer">\\s*<a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com"><img src="${DL_ICON}"`));
    expect(page).toContain('<a href="https://dliu.com">dliu.com</a> · <a href="/docs">Docs</a>');
  }
});

test('docs pages use the shared docs stylesheet and tabs', () => {
  for (const file of ['docs/index.html']) {
    const page = read(file);
    expect(page).toContain(DL_DOCS_CSS);
    expect(page).toContain('<main class="dl-main dl-docs-main">');
    expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections">');
  }
});

test('the docs have Architecture, Every check, Cost, Security and Health tabs', () => {
  const page = read('docs/index.html');
  for (const [id, label] of [['architecture', 'Architecture'], ['checks', 'Every check'], ['cost', 'Cost'], ['security', 'Security'], ['health', 'Health']]) {
    expect(page).toContain(`<a href="/docs#${id}" data-tab="${id}"`);
    expect(page).toContain(`>${label}</a>`);
    expect(page).toContain(`id="${id}" data-section`);
  }
  expect(fs.existsSync(path.join(__dirname, '..', 'web', 'docs', 'health.html'))).toBe(false);
});

test('the Health tab is for people: diagram, numbers and a table, no exact technical details, a link to the Markdown', () => {
  const full = read('docs/index.html');
  const start = full.indexOf('id="health" data-section');
  const page = full.slice(start, full.indexOf('</article>', start));
  expect(page).toContain('class="dg-flow"');
  expect(page).toContain('class="dg-stats"');
  expect(page).toContain('<table class="dl-table">');
  expect(page).not.toMatch(/<details|<code|<pre|\b[1-5]\d\d\b(?! minutes)|application\/|text\/html|https?:\/\/(?!status)/);
  expect(page).toContain('<a href="/docs/health.md">Technical version for machines (Markdown)</a>');
  const markdown = read('docs/health.md');
  for (const key of ['`pages`', '`checker`', 'https://status.dliu.com/data/status.json', 'generatedAt']) expect(markdown).toContain(key);
});

test('the app stylesheet leaves the header, buttons and palette to the shared stylesheet', () => {
  const css = read('style.css');
  expect(css).not.toMatch(/\.dl-header|\.dl-button|\.dl-footer|--dl-[a-z-]+\s*:/);
  expect(css).not.toMatch(/#209cee|#2563eb/i);
});

test('scripts build the page with text, never innerHTML', () => {
  for (const file of ['app.js', 'docs.js']) expect(read(file)).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
});
