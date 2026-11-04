const { probeChina, chinaChecks, judgeProbe, combineProbes, healthFromProbes } = require('../lambda/checker/globalping');
const { chinaResults } = require('../lambda/checker');

const location = { key: 'cn', name: 'China', provider: 'globalping', everyMinutes: 60, slowMs: 6000, probes: [{ magic: 'China Telecom' }, { magic: 'China Unicom' }] };
const config = {
  defaults: { timeoutMs: 10000, slowMs: 3000, failuresBeforeDown: 2 },
  locations: [{ key: 'ie', name: 'Ireland', region: 'eu-west-1' }, location],
  apps: [
    { key: 'a', url: 'https://a.dliu.com/', health: true, functions: [
      { key: 'docs', checks: [{ url: 'https://a.dliu.com/docs', expect: { status: 200 } }] },
      { key: 'pages', checks: [{ url: 'https://a.dliu.com/x', expect: { status: 200 } }, { url: 'https://a.dliu.com/', expect: { status: 200, type: 'text/html', contains: 'dl-header' } }] },
    ] },
    { key: 'b', url: 'https://b.dliu.com/', health: false, functions: [{ key: 'pages', checks: [{ url: 'https://b.dliu.com/', expect: { status: 200 } }] }] },
  ],
};
const probe = (over = {}) => ({
  probe: { city: 'Beijing', network: 'China Telecom' },
  result: { status: 'finished', statusCode: 200, headers: { 'content-type': 'text/html' }, rawBody: '<header class="dl-header">', truncated: false, timings: { total: 900 }, ...over },
});

test('China checks each site home page and /health only', () => {
  expect(chinaChecks(config).map((c) => [c.app, c.fn || 'health', c.index])).toEqual([['a', 'pages', 1], ['a', 'health', undefined], ['b', 'pages', 0]]);
});

test('judges one probe against the expectations; a truncated body may hide the marker', () => {
  const check = config.apps[0].functions[1].checks[1];
  expect(judgeProbe({ ...probe().result, probe: probe().probe }, check, 6000).status).toBe('pass');
  expect(judgeProbe({ ...probe({ statusCode: 502 }).result, probe: probe().probe }, check, 6000).detail).toMatch(/HTTP 502.*Beijing, China Telecom/);
  expect(judgeProbe({ ...probe({ rawBody: '<html>' }).result, probe: probe().probe }, check, 6000).status).toBe('fail');
  expect(judgeProbe({ ...probe({ rawBody: '<html>', truncated: true }).result, probe: probe().probe }, check, 6000).status).toBe('pass');
  expect(judgeProbe({ ...probe({ timings: { total: 7000 } }).result, probe: probe().probe }, check, 6000).status).toBe('warn');
  expect(judgeProbe({ status: 'failed', probe: probe().probe }, check, 6000).status).toBe('fail');
});

test('China fails only when every probe failed', () => {
  expect(combineProbes([{ status: 'fail', detail: 'x' }, { status: 'pass', ms: 800 }], 'c')).toMatchObject({ status: 'pass', detail: '1 of 2 China probes passed, median 800 ms' });
  expect(combineProbes([{ status: 'fail', detail: 'x' }, { status: 'fail', detail: 'y' }], 'c')).toMatchObject({ status: 'fail', detail: 'x' });
  expect(combineProbes([], 'c').status).toBe('fail');
});

test('reads /health from the fastest probe that answered in the agreed format', () => {
  const body = JSON.stringify({ status: 'pass', functions: [{ key: 'db', name: 'Database', status: 'pass' }] });
  const results = [
    { ...probe({ statusCode: 200, rawBody: body, timings: { total: 1200 } }).result, probe: probe().probe },
    { ...probe({ statusCode: 200, rawBody: 'nope', timings: { total: 300 } }).result, probe: probe().probe },
  ];
  expect(healthFromProbes(results, 6000)).toMatchObject({ status: 'pass', ms: 1200, functions: [{ key: 'db', status: 'pass' }] });
  expect(healthFromProbes([{ ...probe({ statusCode: 404 }).result, probe: probe().probe }], 6000).detail).toBe('/health answered HTTP 404');
});

function fakeGlobalping({ limited = false } = {}) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') {
      if (limited) return new Response('{}', { status: 429 });
      const body = JSON.parse(init.body);
      posts.push(body);
      return new Response(JSON.stringify({ id: String(posts.length) }), { status: 202 });
    }
    const id = Number(url.split('/').pop());
    const { request } = posts[id - 1].measurementOptions;
    const rawBody = request.path === '/health' ? JSON.stringify({ status: 'pass', functions: [] }) : '<header class="dl-header">';
    const type = request.path === '/health' ? 'application/health+json' : 'text/html';
    const one = { ...probe({ rawBody, headers: { 'content-type': type } }).result, probe: probe().probe };
    return new Response(JSON.stringify({ status: 'finished', results: [{ probe: one.probe, result: one }, { probe: one.probe, result: one }] }), { status: 200 });
  };
  return { fetchImpl, posts };
}

test('asks Globalping for 2 China probes per check and fills in only the checks China ran', async () => {
  const { fetchImpl, posts } = fakeGlobalping();
  const raw = await probeChina(config, location, { fetchImpl });
  expect(posts).toHaveLength(3);
  expect(posts[0]).toMatchObject({ type: 'http', target: 'a.dliu.com', limit: 2, locations: location.probes, measurementOptions: { protocol: 'HTTPS', request: { method: 'GET', path: '/' } } });
  expect(raw.a.functions.pages[0]).toBeUndefined();
  expect(raw.a.functions.pages[1]).toMatchObject({ status: 'pass' });
  expect(raw.a.health).toMatchObject({ status: 'pass' });
  expect(raw.b.functions.pages[0]).toMatchObject({ status: 'pass' });
}, 20000);

test('runs once an hour, reuses the last results in between, and survives the rate limit', async () => {
  const t = Date.parse('2026-11-04T01:00:00Z');
  const recent = { at: '2026-11-04T00:30:00.000Z', raw: { a: {} } };
  expect(await chinaResults(config, { china: recent }, t)).toMatchObject({ china: recent, raw: recent.raw });
  const { fetchImpl } = fakeGlobalping({ limited: true });
  const old = { at: '2026-11-04T00:00:00.000Z', raw: { a: {} } };
  expect(await chinaResults(config, { china: old }, t, { fetchImpl })).toMatchObject({ china: old, raw: old.raw });
  const ancient = { at: '2026-11-03T22:00:00.000Z', raw: { a: {} } };
  expect(await chinaResults(config, { china: ancient }, t, { fetchImpl })).toMatchObject({ china: null, raw: null });
});
