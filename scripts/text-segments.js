#!/usr/bin/env node
// Lists the translatable text in the site's HTML pages (text between tags, outside code/svg/script/style), one per
// line, normalised. Used by the i18n test to make sure every piece has a Chinese translation in web/zh.js.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['code', 'pre', 'svg', 'script', 'style', 'title']);
const normalise = (text) => text.replace(/\s+/g, ' ').trim();
// Not words: punctuation, numbers, URLs, file names and the like stay as they are in both languages.
const translatable = (text) => /[A-Za-z]{2,}/.test(text) && !/^(https?:\/\/|\/)[^\s]*$/.test(text) && !/^[\w.-]+\.(com|md|json)$/.test(text);

function segments(html) {
  const out = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) { const i = stack.lastIndexOf(tag); if (i >= 0) stack.length = i; }
      else if (!m[4] && !['meta', 'link', 'img', 'br', 'input'].includes(tag)) stack.push(tag);
      const attrs = m[3] || '';
      for (const a of attrs.matchAll(/\b(aria-label|title|alt|content)="([^"]+)"/g)) {
        if (a[1] === 'content' && !/name="description"/.test(attrs)) continue;
        if (translatable(a[2])) out.push(normalise(a[2]));
      }
    } else if (m[5] && !stack.some((t) => SKIP.has(t))) {
      const text = normalise(m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' '));
      if (translatable(text)) out.push(text);
    }
  }
  return out;
}

const WEB = path.join(__dirname, '..', 'web');
const PAGES = ['index.html', '404.html', 'docs/index.html'];
function allSegments() {
  return [...new Set(PAGES.flatMap((p) => segments(fs.readFileSync(path.join(WEB, p), 'utf8'))))];
}

if (require.main === module) for (const s of allSegments()) console.log(s);
module.exports = { segments, allSegments, translatable, normalise };
