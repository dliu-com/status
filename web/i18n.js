'use strict';

// Chinese / English, as on the other dliu.com sites. A choice saved in this browser wins; otherwise the browser's
// language decides (any zh-* is Chinese, everything else English). The pages are written in English; in Chinese,
// every text node and label found in DL_ZH.STATIC (web/zh.js) is replaced, and the scripts use dlI18n for the rest.
(function () {
  const KEY = 'status-language';
  const ZH = window.DL_ZH || { STATIC: {}, NAMES: {} };

  function initialLanguage(saved, browserLanguage) {
    if (saved === 'zh' || saved === 'en') return saved;
    return /^zh(?:-|$)/i.test(browserLanguage || '') ? 'zh' : 'en';
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  const lang = initialLanguage(saved, navigator.language);
  const zh = lang === 'zh';
  const t = (chinese, english) => (zh ? chinese : english);
  const browserLang = String(navigator.language || '').toLowerCase().split('-')[0];
  const locale = browserLang === lang ? undefined : (zh ? 'zh-CN' : 'en-GB');
  const normalise = (text) => text.replace(/\s+/g, ' ').trim();

  const name = (text) => (zh && ZH.NAMES[text]) || text;
  const names = (list) => list.split(/, (?![^(]*\))/).map((part) => name(part.trim())).join('、');
  const joinNames = (list) => (list.length < 2 ? list.join('')
    : zh ? `${list.slice(0, -1).join('、')}和${list[list.length - 1]}` : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

  // Results come from the checker in English; these are the sentences it writes.
  const PATTERNS = [
    [/^(.+)\. Failed once; down if the next check fails too$/, (d) => `${detail(d)}。失败一次；下次仍失败则判为故障`],
    [/^(.+) \(passed on retry\)$/, (d) => `${detail(d)}（重试后通过）`],
    [/^Passed from all (\d+) locations, median (.+)$/, (n, ms) => `全部 ${n} 个地点通过，中位用时 ${ms}`],
    [/^Passed from (.+), median (.+)$/, (where, ms) => `${names(where)} 通过，中位用时 ${ms}`],
    [/^Fails from (.+) only: (.+)$/, (where, d) => `仅 ${names(where)} 失败：${detail(d)}`],
    [/^(\d+) of (\d+) China probes passed, median (.+)$/, (a, b, ms) => `${b} 个中国探针中 ${a} 个通过，中位用时 ${ms}`],
    [/^(.+) \(from (.+)\)$/, (d, where) => `${detail(d)}（来自 ${names(where)}）`],
    // China probes add "(city, network)", shown as they are.
    [/^(.+) \(([^,()]+), ([^()]+)\)$/, (d, city, network) => `${detail(d)}（${city}，${network}）`],
    [/^(.+) (?:is|are) not working normally$/, (list) => `${names(list)}未正常工作`],
    [/^HTTP (\d+) in (.+)$/, (code, ms) => `HTTP ${code}，用时 ${ms}`],
    [/^HTTP (\d+), expected (.+)$/, (code, want) => `HTTP ${code}，应为 ${want.replace(' or ', ' 或 ')}`],
    [/^Slow: (.+)$/, (ms) => `慢：${ms}`],
    [/^No answer within (.+)$/, (s) => `${s}内无响应`],
    [/^Content type (.+), expected (.+)$/, (got, want) => `内容类型 ${got === 'missing' ? '缺失' : got}，应为 ${want}`],
    [/^Content type (.+)$/, (got) => `内容类型 ${got}`],
    [/^Redirects to (.+), expected (.+)$/, (got, want) => `重定向到 ${got === 'nowhere' ? '空' : got}，应为 ${want}`],
    [/^JSON has no "(.+)"$/, (key) => `JSON 缺少 "${key}"`],
    [/^JSON "(.+)" is not (.+)$/, (key, want) => `JSON "${key}" 不是 ${want}`],
    [/^JSON "(.+)" is missing or malformed$/, (key) => `JSON "${key}" 缺失或格式错误`],
    [/^\/health answered HTTP (\d+)$/, (code) => `/health 返回 HTTP ${code}`],
    [/^Answered in (.+)$/, (ms) => `响应用时 ${ms}`],
    [/^(.+): did not run$/, (where) => `${name(where)}：未运行`],
  ];
  const SENTENCES = {
    'Working': '正常',
    'All functions working': '所有功能正常',
    'Could not connect': '无法连接',
    'Page content is missing its marker': '页面内容缺少标记',
    'Answer is not JSON': '返回的不是 JSON',
    'Answer is not a JSON object': '返回的不是 JSON 对象',
    'Body could not be read': '无法读取响应内容',
    'No answer from /health': '/health 无响应',
    '/health: no answer': '/health 无响应',
    '/health did not return JSON': '/health 返回的不是 JSON',
    '/health answer is not in the agreed format': '/health 返回格式不符合约定',
    '/health was not read': '未读取 /health',
    'Reported working': '报告正常',
    'Reported slow or partly working': '报告慢或部分正常',
    'Reported failing': '报告失败',
    'Not reported by /health': '/health 未报告',
    'No location could run this check': '没有地点能运行这项检查',
    'No China probe answered': '中国探针都没有响应',
    'No answer': '无响应',
    'Redirects elsewhere': '重定向到其他地址',
    'slow': '慢',
    'timeout': '超时',
    'read failed': '读取失败',
  };

  function detail(text) {
    if (!zh || !text) return text;
    if (SENTENCES[text]) return SENTENCES[text];
    for (const [pattern, translate] of PATTERNS) {
      const match = pattern.exec(text);
      if (match) return translate(...match.slice(1));
    }
    return name(text);
  }

  const SKIP = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'svg']);
  function translatePage() {
    document.documentElement.lang = zh ? 'zh-CN' : 'en';
    if (!zh) return;
    document.title = document.title.split(' · ').map((part) => ZH.STATIC[part] || part).join(' · ');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        for (let el = node.parentElement; el; el = el.parentElement) if (SKIP.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const key = normalise(node.nodeValue);
      if (key && ZH.STATIC[key]) node.nodeValue = ZH.STATIC[key];
    }
    for (const el of document.querySelectorAll('[aria-label], [title], meta[name="description"]')) {
      for (const attribute of ['aria-label', 'title', 'content']) {
        const value = el.getAttribute(attribute);
        if (value && ZH.STATIC[normalise(value)]) el.setAttribute(attribute, ZH.STATIC[normalise(value)]);
      }
    }
  }

  // The shared dl-language switcher (dl.css): 中文 | English, or a 文/A menu on narrow screens.
  function wireSwitcher() {
    const box = document.querySelector('.dl-language');
    if (!box) return;
    const toggle = box.querySelector('.dl-language-toggle');
    const group = box.querySelector('.dl-languages');
    const setOpen = (open) => {
      group.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    for (const button of group.querySelectorAll('button[data-language]')) {
      button.setAttribute('aria-pressed', String(button.dataset.language === lang));
      button.addEventListener('click', () => {
        setOpen(false);
        if (button.dataset.language === lang) return;
        try { localStorage.setItem(KEY, button.dataset.language); } catch { /* nowhere to remember it */ }
        location.reload();
      });
    }
    toggle.addEventListener('click', () => setOpen(!group.classList.contains('is-open')));
    document.addEventListener('click', (event) => { if (!box.contains(event.target)) setOpen(false); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && group.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
    });
  }

  translatePage();
  wireSwitcher();
  window.dlI18n = { lang, t, locale, name, names, joinNames, detail, initialLanguage };
})();
