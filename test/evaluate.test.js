const { judgeApp, recordRun, buildPublic, uptime } = require('../lambda/checker/evaluate');

const defaults = { failuresBeforeDown: 2 };
const app = {
  key: 'a', name: 'App A', url: 'https://a.dliu.com/', docs: 'https://a.dliu.com/docs/health',
  functions: [
    { key: 'pages', name: 'Pages', checks: [] },
    { key: 'docs', name: 'Docs', critical: false, checks: [] },
  ],
};
const pass = { name: 'c', status: 'pass', detail: 'ok' };
const fail = { name: 'c', status: 'fail', detail: 'HTTP 500' };
const warn = { name: 'c', status: 'warn', detail: 'Slow: 4.0 s' };

test('a failing function is degraded after one failed run and down after two', () => {
  const first = judgeApp(app, { pages: [fail], docs: [pass] }, null, {}, defaults);
  expect(first.functions[0].status).toBe('degraded');
  expect(first.status).toBe('degraded');
  const second = judgeApp(app, { pages: [fail], docs: [pass] }, null, first.streaks, defaults);
  expect(second.functions[0].status).toBe('down');
  expect(second.status).toBe('down');
  const recovered = judgeApp(app, { pages: [pass], docs: [pass] }, null, second.streaks, defaults);
  expect(recovered.status).toBe('up');
  expect(recovered.streaks.pages).toBe(0);
});

test('an optional function being down only degrades the site; a slow check degrades it', () => {
  const run1 = judgeApp(app, { pages: [pass], docs: [fail] }, null, {}, defaults);
  const run2 = judgeApp(app, { pages: [pass], docs: [fail] }, null, run1.streaks, defaults);
  expect(run2.functions[1].status).toBe('down');
  expect(run2.status).toBe('degraded');
  expect(judgeApp(app, { pages: [warn], docs: [pass] }, null, {}, defaults).status).toBe('degraded');
});

test('/health results join functions with the same key and add new ones', () => {
  const health = { status: 'pass', detail: 'Answered', ms: 50, functions: [
    { key: 'pages', name: 'Pages', status: 'pass', output: '' },
    { key: 'db', name: 'Database', status: 'warn', output: 'slow' },
  ] };
  const result = judgeApp(app, { pages: [pass], docs: [pass] }, health, {}, defaults);
  expect(result.functions.map((f) => f.key)).toEqual(['pages', 'docs', 'health', 'db']);
  expect(result.functions[0].checks).toHaveLength(2);
  expect(result.functions.find((f) => f.key === 'db').status).toBe('degraded');
});

test('records daily counts, the last 24 hours and status changes as incidents', () => {
  const t0 = Date.parse('2026-11-03T10:00:00Z');
  const up = { key: 'a', status: 'up', detail: 'All functions working', streaks: {} };
  const down = { key: 'a', status: 'down', detail: 'Pages is not working normally', streaks: { pages: 2 } };
  let state = recordRun({}, [up], t0);
  expect(state.incidents).toHaveLength(0);
  state = recordRun(state, [down], t0 + 15 * 60000);
  state = recordRun(state, [down], t0 + 30 * 60000);
  expect(state.incidents).toHaveLength(1);
  expect(state.incidents[0]).toMatchObject({ app: 'a', from: 'up', to: 'down' });
  expect(state.days.a['2026-11-03']).toEqual([1, 0, 2]);
  expect(state.recent.a).toHaveLength(3);
  state = recordRun(state, [up], t0 + 25 * 3600000);
  expect(state.recent.a).toHaveLength(1);
  expect(uptime(state.days.a, t0 + 25 * 3600000, 2)).toBe(50);
});

test('the public file leaves private sites out entirely', () => {
  const config = { intervalMinutes: 15, apps: [app, { ...app, key: 'p', name: 'Private', private: true }] };
  const results = [judgeApp(app, { pages: [pass], docs: [pass] }, null, {}, defaults), { ...judgeApp(app, { pages: [fail], docs: [pass] }, null, { pages: 1 }, defaults), key: 'p' }];
  const now = Date.parse('2026-11-03T10:00:00Z');
  let state = recordRun({}, results, now);
  state = recordRun(state, results.map((r) => ({ ...r, status: 'up' })), now + 1);
  const view = buildPublic(config, state, results, now);
  expect(view.apps.map((a) => a.key)).toEqual(['a']);
  expect(JSON.stringify(view)).not.toMatch(/Private|"p"/);
  expect(view.incidents.every((i) => i.app === 'a')).toBe(true);
  expect(view.status).toBe('up');
  expect(view.apps[0].days).toHaveLength(90);
});

test('a function configured to come from /health fails when /health stops reporting it', () => {
  const withHealthOnly = { ...app, functions: [...app.functions, { key: 'media', name: 'Media', critical: false, checks: [] }] };
  const health = { status: 'pass', detail: 'Answered', ms: 50, functions: [] };
  const result = judgeApp(withHealthOnly, { pages: [pass], docs: [pass] }, health, {}, defaults);
  const media = result.functions.find((f) => f.key === 'media');
  expect(media.checks[0].detail).toBe('Not reported by /health');
  expect(media.status).toBe('degraded');
  expect(media.critical).toBe(false);
});
