const { mergeResults, mergeHealth, mergeLocations } = require('../lambda/checker/locations');

const ie = { key: 'ie', name: 'Ireland' };
const us = { key: 'us', name: 'Virginia (US)' };
const jp = { key: 'jp', name: 'Tokyo' };
const ok = (ms = 100) => ({ status: 'pass', detail: 'HTTP 200', ms });
const bad = { status: 'fail', detail: 'HTTP 502', ms: 50 };
const slow = { status: 'warn', detail: 'Slow: 4.0 s', ms: 4000 };

test('fails only when most locations fail', () => {
  expect(mergeResults([{ location: ie, result: bad }, { location: us, result: bad }, { location: jp, result: ok() }], 'c')).toMatchObject({
    status: 'fail', detail: 'HTTP 502 (from Ireland, Virginia (US))',
  });
  const one = mergeResults([{ location: ie, result: ok() }, { location: us, result: ok() }, { location: jp, result: bad }], 'c');
  expect(one.status).toBe('warn');
  expect(one.detail).toBe('Fails from Tokyo only: HTTP 502');
  expect(one.locations.jp.status).toBe('fail');
});

test('passes with the median time, and is slow only when most locations are slow', () => {
  expect(mergeResults([{ location: ie, result: ok(100) }, { location: us, result: ok(300) }, { location: jp, result: ok(900) }], 'c')).toMatchObject({
    status: 'pass', ms: 300, detail: 'Passed from all 3 locations, median 300 ms',
  });
  expect(mergeResults([{ location: ie, result: ok() }, { location: us, result: slow }, { location: jp, result: ok() }], 'c').status).toBe('pass');
  expect(mergeResults([{ location: ie, result: slow }, { location: us, result: slow }, { location: jp, result: ok() }], 'c').status).toBe('warn');
});

test('a location whose probe did not answer is left out; none at all is a failure', () => {
  const two = mergeResults([{ location: ie, result: ok() }, { location: us, result: undefined }, { location: jp, result: bad }], 'c');
  expect(two.status).toBe('warn');
  expect(two.locations).not.toHaveProperty('us');
  expect(mergeResults([{ location: ie }, { location: us }], 'c')).toMatchObject({ status: 'fail', detail: 'No location could run this check' });
});

test('merges /health answers function by function', () => {
  const answer = (db) => ({ status: 'pass', detail: 'Answered', ms: 80, functions: [{ key: 'db', name: 'Database', status: db, output: db === 'pass' ? '' : 'timeout' }] });
  const merged = mergeHealth([{ location: ie, result: answer('pass') }, { location: us, result: answer('fail') }, { location: jp, result: answer('pass') }]);
  expect(merged.status).toBe('pass');
  expect(merged.functions).toEqual([{ key: 'db', name: 'Database', status: 'warn', output: 'timeout (from Virginia (US) only)' }]);
  const down = mergeHealth([{ location: ie, result: answer('fail') }, { location: us, result: answer('fail') }, { location: jp, result: answer('pass') }]);
  expect(down.functions[0]).toMatchObject({ status: 'fail', output: 'timeout' });
});

test('merges every site, function and check by position', () => {
  const apps = [{ key: 'a', health: false, functions: [{ key: 'pages', checks: [{ url: 'https://a.dliu.com/', expect: { status: 200 } }] }] }];
  const raw = (result) => ({ a: { functions: { pages: [result] }, health: null } });
  const merged = mergeLocations(apps, [{ location: ie, raw: raw(ok()) }, { location: us, raw: null }, { location: jp, raw: raw(ok()) }]);
  expect(merged.a.functions.pages[0]).toMatchObject({ name: 'GET / → 200', status: 'pass', detail: 'Passed from Ireland, Tokyo, median 100 ms' });
  expect(merged.a.health).toBeNull();
});
