const config = require('../config/apps.json');

test('runs every 15 minutes with sane defaults', () => {
  expect(config.intervalMinutes).toBe(15);
  expect(config.defaults).toEqual({ timeoutMs: 10000, slowMs: 3000, failuresBeforeDown: 2 });
});

test('locations: Ireland first (the checker), then the probes', () => {
  expect(config.locations.map((l) => l.key)).toEqual(['ie', 'us', 'jp']);
  expect(config.locations[0].region).toBe('eu-west-1');
});

test('every site has a key, name, https URL, testing page and functions with checks', () => {
  const keys = new Set();
  for (const app of config.apps) {
    expect(app.key).toMatch(/^[a-z0-9-]+$/);
    expect(keys.has(app.key)).toBe(false);
    keys.add(app.key);
    expect(app.name).toBeTruthy();
    expect(app.url).toMatch(/^https:\/\/([a-z0-9-]+\.)?dliu\.com\/$/);
    expect(app.docs).toBe(`${app.url}docs#health`);
    expect(typeof app.health).toBe('boolean');
    expect(app.functions.length).toBeGreaterThan(0);
    for (const fn of app.functions) {
      expect(fn.key).toMatch(/^[a-z0-9-]+$/);
      if (fn.key === 'health') expect(app.health).toBe(true);
      // Functions with no guest checks are filled in by the site's /health.
      if (!app.health) expect(fn.checks.length).toBeGreaterThan(0);
    }
  }
});

test('checks are read only, stay on the site and never sign in', () => {
  for (const app of config.apps) {
    const host = new URL(app.url).host;
    for (const fn of app.functions) for (const check of fn.checks) {
      expect(['GET', 'HEAD', undefined]).toContain(check.method);
      // The site itself, or its own managed API on API Gateway when its testing page lists it.
      expect(new URL(check.url).host).toMatch(new RegExp(`^(${host.replace(/\./g, '\\.')}|[a-z0-9]+\\.execute-api\\.eu-west-1\\.amazonaws\\.com)$`));
      expect(check).not.toHaveProperty('headers');
      expect(check).not.toHaveProperty('body');
    }
  }
});

test('cyy.dliu.com, link.dliu.com and home.dliu.com are not checked', () => {
  const hosts = config.apps.map((a) => new URL(a.url).host);
  expect(hosts).not.toContain('cyy.dliu.com');
  expect(hosts).not.toContain('link.dliu.com');
  expect(hosts).not.toContain('home.dliu.com');
});
