# dliu.com health contract

How every dliu.com site lets [status.dliu.com](https://status.dliu.com) test it. Follow this when adding or changing a
site. The status checker is an anonymous guest: it never signs in and has no AWS access to the sites.

The testing interface is separate from the site's managed API (`/docs/api`, which is for signed-in users changing
content). They share no routes and no credentials.

## 1. Testing instructions (every site): `/docs#health` for people, `/docs/health.md` for machines

The same content in two forms, kept in sync:

**`/docs#health`: a tab for people.** It's a tab named *Health* (`#health`) on the site's `/docs` page, next to its
other tabs (Technical architecture, Cost, Security…), with the shared docs look (`dl.css`, `dl-docs.css`, `dl-tabs`,
and the `dg-*` diagram kit). The old `/docs/health` URL answers `301` with `Location: /docs#health`.

It is for someone who isn't technical, so it shows rather than tells. **High-level technical details are fine**, such
as which endpoint or page is tested (`/health`, `/api/me`, the home page); **exact ones are not**: no status codes,
headers, content types, body markers, JSON or code, and no folded `<details>` blocks. Use:

- **Flows**: how a test run goes, step by step (status.dliu.com visits as a guest → the site's pages and functions →
  the site checks its own storage → working / slow / not working), with the `dg-flow`, `dg-step` and `dg-arrow`
  classes and `dg-good`, `dg-warn` and `dg-bad` for the outcomes.
- **Numbers**: big figures with `dg-stats` / `dg-stat`, for example "6 functions tested", "14 checks", "every 15
  minutes", "from 3 places", "0 sign-ins needed".
- **Tables**: one row per function in plain words: what it does for a visitor, how it's tested, and what a visitor
  would notice if it stopped working, with a working / not working mark.
- **Charts**: for example how many checks each function has, or what is tested versus what a guest can't test.
- A short **not tested** list in plain words (signed-in actions such as uploads and edits).
- One link at the end: "Technical version for machines (Markdown)" → `/docs/health.md`.

**`/docs/health.md`: a Markdown file for machines and AI agents.** It's served as `text/markdown; charset=utf-8`, contains
the full text with every technical detail unfolded, and is enough on its own to implement the tests:

- **Functions**: key, name, what it does, and whether it's critical (the site is "down" without it).
- **Guest checks**: a table with one row per check: function key, method (GET/HEAD only, no cookies), absolute URL,
  expected status code, content type, a fixed body marker or JSON key (or the redirect `Location` prefix), and an
  optional slow threshold. Example rows: `GET /` → `200 text/html`, contains `dl-header`; `GET /auth/login` → `302`,
  `Location` starts with `https://login.microsoftonline.com/`; `GET /api/me` → `401 application/json`.
- **Health endpoint** (if the site has a backend): URL, caching, response format, every function key it reports and
  what each check reads.
- **Not tested**: signed-in actions a guest can't test.
- **Rules**: the tests are read only and must never change content.

## 2. `/health` endpoint (sites with a backend)

`GET https://<site>/health` (outside `/api/`).

- **No authentication.** CloudFront's `/health` behavior forwards no cookies, no `Authorization` header and no query
  string to the origin, and the handler reads none of them.
- **Read only.** No writes, no side effects, no S3 LIST, and no calls to paid or rate-limited third parties (Microsoft
  Graph, AbuseIPDB…). One cheap read per dependency (DynamoDB `GetItem` of a fixed key, S3 `HeadObject` of a known
  object, an SSM parameter read the app already does). Each check has its own timeout; the whole response returns
  within 5 s.
- **Cached for 60 s at CloudFront** (cache policy keyed on nothing, `max-age=60`), so it runs at most about once a
  minute however often it is requested.
- **Reveals nothing private.** No table, bucket or function names, no counts, no user data, no stack traces. `output`
  is a short generic reason, such as `timeout` or `read failed`.
- **Format** (after the IETF draft *Health Check Response Format for HTTP APIs*): `Content-Type: application/health+json`,
  HTTP `200` when `status` is `pass` or `warn`, `503` when it is `fail`:

```json
{
  "status": "pass",
  "time": "2026-11-03T23:00:00Z",
  "functions": [
    { "key": "records", "name": "Task records", "status": "pass" },
    { "key": "signin", "name": "Microsoft sign-in", "status": "warn", "output": "slow" }
  ]
}
```

`status` is `pass`, `warn` or `fail`; the top-level `status` is the worst of the functions'. The function keys match the
ones listed in the `/docs#health` tab and `/docs/health.md`.

## 3. Tests in the site's repo

A test that fails if the `/docs#health` tab, the `/docs/health` → `/docs#health` redirect, `/docs/health.md` or `/health` disappears, if `/health` starts reading cookies or
the `Authorization` header, if the tab loses its diagram or gains exact technical details (status codes, JSON,
`<details>` blocks), or if the functions in the tab, the Markdown file and the endpoint drift apart.

## How status.dliu.com uses it

Every 15 minutes the checker reads each site's guest checks (from `/docs/health.md`, built into status's config) and
requests them and `/health`, as user agent
`dliu-status-bot/1.0 (+https://status.dliu.com/docs)`. traffic.dliu.com drops requests with that user agent, so they
never count as traffic. A failing check is retried once in the same run; a function is **down** after two failed runs
in a row and **degraded** after one, or when `/health` reports `warn` or a page is slow.
