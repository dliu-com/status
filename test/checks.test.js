const { runHttpCheck, runHealthCheck, checkName, USER_AGENT } = require('../lambda/checker/checks');

const defaults = { timeoutMs: 1000, slowMs: 3000, failuresBeforeDown: 2 };
const opts = (fetchImpl) => ({ fetchImpl, retryDelayMs: 0 });

function reply(status, { type = 'text/html', body = '', location } = {}) {
  const headers = new Headers();
  if (type) headers.set('content-type', type);
  if (location) headers.set('location', location);
  return new Response(status === 204 || status === 302 ? null : body, { status, headers });
}

test('passes a page with the right status, type and marker, as a cookie-less guest with the status user agent', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return reply(200, { body: '<footer class="dl-footer">' }); };
  const result = await runHttpCheck({ url: 'https://a.dliu.com/', expect: { status: 200, type: 'text/html', contains: 'dl-footer' } }, defaults, opts(fetchImpl));
  expect(result.status).toBe('pass');
  expect(calls[0].init.headers['user-agent']).toBe(USER_AGENT);
  expect(USER_AGENT).toMatch(/bot/);
  expect(calls[0].init.headers).not.toHaveProperty('cookie');
  expect(calls[0].init.headers).not.toHaveProperty('authorization');
  expect(calls[0].init.redirect).toBe('manual');
  expect(calls[0].init.method).toBe('GET');
});

test('fails on a wrong status, type, marker, JSON key or redirect target', async () => {
  const cases = [
    [{ status: 200 }, reply(503)],
    [{ status: 200, type: 'text/html' }, reply(200, { type: 'application/json' })],
    [{ status: 200, contains: 'dl-footer' }, reply(200, { body: '<html>' })],
    [{ status: 200, json: 'records' }, reply(200, { type: 'application/json', body: '{"x":1}' })],
    [{ status: 200, json: 'records' }, reply(200, { type: 'application/json', body: 'not json' })],
    [{ status: 200, jsonEquals: { configured: true } }, reply(200, { type: 'application/json', body: '{"configured":"true"}' })],
    [{ status: 200, jsonPattern: { id: '^[0-9a-f-]{36}$' } }, reply(200, { type: 'application/json', body: '{"id":"nope"}' })],
    [{ status: 302, location: 'https://login.microsoftonline.com/' }, reply(302, { location: 'https://evil.example/' })],
  ];
  for (const [expectation, response] of cases) {
    const result = await runHttpCheck({ url: 'https://a.dliu.com/x', expect: expectation }, defaults, opts(async () => response.clone()));
    expect(result.status).toBe('fail');
  }
});

test('accepts the expected redirect and the expected 401', async () => {
  const signin = await runHttpCheck({ url: 'https://a.dliu.com/auth/login', expect: { status: 302, location: 'https://login.microsoftonline.com/' } }, defaults,
    opts(async () => reply(302, { type: null, location: 'https://login.microsoftonline.com/tenant/oauth2' })));
  expect(signin.status).toBe('pass');
  const api = await runHttpCheck({ url: 'https://a.dliu.com/api/me', expect: { status: 401, type: 'application/json' } }, defaults,
    opts(async () => reply(401, { type: 'application/json; charset=utf-8', body: '{}' })));
  expect(api.status).toBe('pass');
});

test('checks exact JSON values and patterns without echoing them', async () => {
  const body = '{"configured":true,"tenantId":"d6229c1d-85e4-4a28-bd67-6c14b995fcae"}';
  const result = await runHttpCheck({ url: 'https://a.dliu.com/config.json', expect: { status: 200, jsonEquals: { configured: true }, jsonPattern: { tenantId: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } },
    defaults, opts(async () => reply(200, { type: 'application/json', body })));
  expect(result.status).toBe('pass');
  const bad = await runHttpCheck({ url: 'https://a.dliu.com/config.json', expect: { status: 200, jsonPattern: { tenantId: '^x$' } } },
    defaults, opts(async () => reply(200, { type: 'application/json', body })));
  expect(bad.detail).not.toContain('d6229c1d');
});

test('retries a failure once in the same run', async () => {
  let n = 0;
  const flaky = async () => (n++ === 0 ? reply(502) : reply(200));
  const result = await runHttpCheck({ url: 'https://a.dliu.com/', expect: { status: 200 } }, defaults, opts(flaky));
  expect(result.status).toBe('pass');
  expect(result.detail).toMatch(/retry/);
  expect(n).toBe(2);
});

test('reports a timeout or connection error as a failure', async () => {
  const timeout = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  expect((await runHttpCheck({ url: 'https://a.dliu.com/', expect: {} }, defaults, opts(timeout))).detail).toMatch(/No answer/);
  const refused = async () => { throw new TypeError('fetch failed'); };
  expect((await runHttpCheck({ url: 'https://a.dliu.com/', expect: {} }, defaults, opts(refused))).detail).toBe('Could not connect');
});

test('a slow answer is a warning', async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 30)); return reply(200); };
  const result = await runHttpCheck({ url: 'https://a.dliu.com/', expect: {} }, { ...defaults, slowMs: 10 }, opts(slow));
  expect(result.status).toBe('warn');
});

test('names checks from their method, path and expected status', () => {
  expect(checkName({ url: 'https://a.dliu.com/api/me', expect: { status: 401 } })).toBe('GET /api/me → 401');
  expect(checkName({ url: 'https://a.dliu.com/x.pdf', method: 'HEAD', expect: {} })).toBe('HEAD /x.pdf → 200');
  expect(checkName({ url: 'http://a.dliu.com/', method: 'HEAD', expect: { status: 301 } })).toBe('HEAD http://a.dliu.com/ → 301');
  expect(checkName({ name: 'Custom', url: 'https://a.dliu.com/' })).toBe('Custom');
});

describe('/health', () => {
  const health = (status, body) => async () => reply(status, { type: 'application/health+json', body: JSON.stringify(body) });

  test('reads the reported functions from a pass or fail answer', async () => {
    const result = await runHealthCheck('https://a.dliu.com/health', defaults, opts(health(503, {
      status: 'fail', functions: [{ key: 'db', name: 'Database', status: 'fail', output: 'timeout' }, { key: 'x', status: 'bogus' }],
    })));
    expect(result.status).toBe('pass');
    expect(result.functions).toEqual([{ key: 'db', name: 'Database', status: 'fail', output: 'timeout' }]);
  });

  test('fails when the endpoint is missing or answers in another format', async () => {
    expect((await runHealthCheck('https://a.dliu.com/health', defaults, opts(async () => reply(404)))).status).toBe('fail');
    expect((await runHealthCheck('https://a.dliu.com/health', defaults, opts(health(200, { ok: true })))).status).toBe('fail');
  });
});
