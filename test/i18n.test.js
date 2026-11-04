const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { allSegments } = require('../scripts/text-segments');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8');
const context = { window: {} };
vm.runInNewContext(read('zh.js'), context);
const ZH = context.window.DL_ZH;

test('every piece of English text on the pages has a Chinese translation', () => {
  const missing = allSegments().filter((text) => !ZH.STATIC[text]);
  expect(missing).toEqual([]);
});

test('every page has the shared 中文 | English switcher last in the header and loads the translations first', () => {
  for (const file of ['index.html', '404.html', 'docs/index.html']) {
    const page = read(file);
    const nav = page.slice(page.indexOf('<nav class="dl-nav"'), page.indexOf('</nav>'));
    expect(nav).toMatch(/<div class="dl-language">[\s\S]*data-language="zh"[\s\S]*data-language="en"[\s\S]*<\/div>\s*<\/div>\s*$/);
    expect(page.indexOf('<script src="/zh.js"')).toBeLessThan(page.indexOf('<script src="/i18n.js"'));
    const own = page.match(/<script src="\/(app|docs)\.js"/);
    if (own) expect(page.indexOf('<script src="/i18n.js"')).toBeLessThan(own.index);
  }
});

function i18n(language, saved = null) {
  const window = { DL_ZH: ZH };
  const sandbox = {
    window,
    navigator: { language },
    localStorage: { getItem: () => saved, setItem() {} },
    document: { documentElement: {}, querySelector: () => null, querySelectorAll: () => [], title: '', createTreeWalker: () => ({ nextNode: () => false }), body: {} },
    NodeFilter: { SHOW_TEXT: 4 },
    location: {},
  };
  vm.runInNewContext(read('i18n.js'), sandbox);
  return window.dlI18n;
}

test('Chinese for a zh browser or a saved choice, English otherwise', () => {
  expect(i18n('zh-CN').lang).toBe('zh');
  expect(i18n('en-GB').lang).toBe('en');
  expect(i18n('zh-TW', 'en').lang).toBe('en');
  expect(i18n('en-US', 'zh').lang).toBe('zh');
});

test('translates what the checker writes, and leaves unknown text as it is', () => {
  const { detail, name } = i18n('zh-CN');
  expect(detail('Passed from all 3 locations, median 210 ms')).toBe('全部 3 个地点通过，中位用时 210 ms');
  expect(detail('Fails from Tokyo only: HTTP 502')).toBe('仅 东京 失败：HTTP 502');
  expect(detail('HTTP 502 (from Ireland, Virginia (US))')).toBe('HTTP 502（来自 爱尔兰、弗吉尼亚（美国））');
  expect(detail('Could not connect (from here). Failed once; down if the next check fails too')).toBe('无法连接（来自 本地）。失败一次；下次仍失败则判为故障');
  expect(detail('Pages, Docs are not working normally')).toBe('页面、文档未正常工作');
  expect(detail('2 of 2 China probes passed, median 1.0 s')).toBe('2 个中国探针中 2 个通过，中位用时 1.0 s');
  expect(detail('Answered in 651 ms (Dongguan, China Telecom)')).toBe('响应用时 651 ms（Dongguan，China Telecom）');
  expect(detail('Something new')).toBe('Something new');
  expect(name('DL video')).toBe('DL 视频');
  expect(i18n('en-GB').detail('Passed from all 3 locations, median 210 ms')).toBe('Passed from all 3 locations, median 210 ms');
});
