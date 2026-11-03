# dliu.com health contract

How every dliu.com site lets [status.dliu.com](https://status.dliu.com) test it. Follow this when adding or changing a
site. The status checker is an anonymous guest: it never signs in and has no AWS access to the sites.

The testing interface is separate from the site's managed API (`/docs/api`, which is for signed-in users changing
content). They share no routes and no credentials.

## 1. Testing instructions (every site): `/docs/health` for people, `/docs/health.md` for machines

The same content in two forms, kept in sync:

**`/docs/health`: an HTML page for people.** It sits next to the site's other docs pages and uses the shared docs look
(`dl.css`, `dl-docs.css`, `dl-tabs`, and the `dg-*` diagram kit). Someone who isn't technical should understand it at a
glance:

- A **diagram** of how the site is tested: status.dliu.com, as a guest, → the site's pages and public URLs → (if there
  is a backend) `/health` → each function's dependency (database, storage…) → pass / warn / fail. Use the `dg-flow`,
  `dg-step` and `dg-arrow` classes (and `dg-good`, `dg-warn` and `dg-bad` for the results), like the architecture
  diagrams on the other docs pages.
- One short plain-language line per **function** (for example *Pages*, *Game API*, *Sign-in*, *Report rendering*)
  saying what is checked and what "down" would mean for a visitor.
- **What isn't tested**: signed-in actions such as uploads and edits, in plain words.
- Every technical detail **folded** in `<details>` blocks, closed by default: URLs, methods, status codes, headers,
  content types, body markers, the `/health` JSON, timeouts and caching. A link to `/docs/health.md` says
  "Full technical version (Markdown)".

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
ones listed on `/docs/health`.

## 3. Tests in the site's repo

A test that fails if `/docs/health`, `/docs/health.md` or `/health` disappears, if `/health` starts reading cookies or
the `Authorization` header, if the page loses its diagram or its technical details stop being folded, or if the
function keys in the page, the Markdown file and the endpoint drift apart.

## How status.dliu.com uses it

Every 15 minutes the checker reads each site's guest checks (from `/docs/health.md`, built into status's config) and
requests them and `/health`, as user agent
`dliu-status-bot/1.0 (+https://status.dliu.com/docs)`. traffic.dliu.com drops requests with that user agent, so they
never count as traffic. A failing check is retried once in the same run; a function is **down** after two failed runs
in a row and **degraded** after one, or when `/health` reports `warn` or a page is slow.
