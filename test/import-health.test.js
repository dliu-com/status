const { parse } = require('../scripts/import-health');

const markdown = `# x
## Functions

| Key | Name | What it does | Critical |
| --- | --- | --- | --- |
| \`pages\` | Pages | p | yes |
| \`signin\` | Sign-in | s | no |
| \`db\` | Database | d | yes |

## Guest checks

| Function | Method | URL | Status | Content type | Body marker, JSON key or \`Location\` prefix | Slow after |
| --- | --- | --- | --- | --- | --- | --- |
| \`pages\` | GET | https://a.dliu.com/ | 200 | \`text/html\` | contains \`class="dl-header"\` | 2000 ms |
| \`pages\` | HEAD | http://a.dliu.com/ | 301 | — | \`https://a.dliu.com/\` | — |
| \`signin\` | GET | https://a.dliu.com/auth/login | 302 | — | \`Location\` starts with \`https://login.microsoftonline.com/\` | 3000 ms |
| \`signin\` | GET | /api/me | 401 | \`application/json\` | JSON key \`error\` | 3000 ms |
| pages, db | GET | https://a.dliu.com/health | 200 | \`application/health+json\` | JSON key \`status\` | 3000 ms |

## Health endpoint

\`GET https://a.dliu.com/health\`
`;

test('turns a testing page into functions and checks', () => {
  const { health, functions } = parse(markdown, 'a.dliu.com');
  expect(health).toBe(true);
  expect(functions.map((f) => [f.key, f.critical, f.checks.length])).toEqual([['pages', undefined, 2], ['signin', false, 2], ['db', undefined, 0]]);
  expect(functions[0].checks[0]).toEqual({ url: 'https://a.dliu.com/', expect: { status: 200, type: 'text/html', contains: 'class="dl-header"' }, slowMs: 2000 });
  expect(functions[0].checks[1]).toEqual({ url: 'http://a.dliu.com/', method: 'HEAD', expect: { status: 301, location: 'https://a.dliu.com/' } });
  expect(functions[1].checks[0].expect).toEqual({ status: 302, location: 'https://login.microsoftonline.com/' });
  expect(functions[1].checks[1]).toMatchObject({ url: 'https://a.dliu.com/api/me', expect: { status: 401, type: 'application/json', json: 'error' } });
});

test('a site without a backend has no health endpoint', () => {
  expect(parse(markdown.replace(/## Health endpoint[\s\S]*/, '## Health endpoint\n\nNone. No backend.\n'), 'a.dliu.com').health).toBe(false);
});
