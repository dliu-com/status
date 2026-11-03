const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8');
const DL_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css">';
const DL_DOCS_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl-docs.css">';
const DL_ICON = 'https://files.dliu.com/dliu.com/favicon.png';
const PAGES = ['index.html', '404.html', 'docs/index.html', 'docs/health.html'];

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
  for (const file of ['docs/index.html', 'docs/health.html']) {
    const page = read(file);
    expect(page).toContain(DL_DOCS_CSS);
    expect(page).toContain('<main class="dl-main dl-docs-main">');
    expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections">');
  }
});

test('the testing page has a diagram, folds its technical details and links the Markdown version', () => {
  const page = read('docs/health.html');
  expect(page).toContain('class="dg-flow"');
  expect(page).toMatch(/<details>\s*<summary>Technical details/);
  expect(page).not.toMatch(/<details[^>]* open/);
  expect(page).toContain('<a href="/docs/health.md">');
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
