# dliu.com health contract

How every dliu.com site lets [status.dliu.com](https://status.dliu.com) test it. Follow this when adding or changing a
site. The status checker is an anonymous guest: it never signs in and has no AWS access to the sites.

The testing interface is separate from the site's managed API (`/docs/api`, which is for signed-in users changing
content). They share no routes and no credentials.

## 1. `/docs/health` page (every site)

A public docs page, next to the site's other docs pages, using the shared docs look (`dl.css`, `dl-docs.css`,
`dl-tabs`). It says, for a person or an AI agent:

- **Functions** – the site's functions (for example *Pages*, *Game API*, *Sign-in*, *Report rendering*), one line each
  on what it does for a guest.
- **Guest checks** – a table of the public URLs a guest can request to test each function, with the method, the expected
  status code, content type and a fixed marker in the body (or the redirect target). Only GET or HEAD, with no cookies.
  Example rows: `GET /` → `200 text/html`, contains `dl-header`; `GET /auth/login` → `302` to
  `https://login.microsoftonline.com/`; `GET /api/me` → `401 application/json`.
- **Health endpoint** – the functions `/health` reports and what each check does (if the site has a backend).
- **Not tested** – what a guest cannot test (signed-in actions such as uploads and edits).

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

A test that fails if `/docs/health` or `/health` disappears, if `/health` starts reading cookies or the `Authorization`
header, or if the function keys on the page and in the endpoint drift apart.

## How status.dliu.com uses it

Every 15 minutes the checker requests each site's guest checks and `/health`, as user agent
`dliu-status-bot/1.0 (+https://status.dliu.com/docs)`. traffic.dliu.com drops requests with that user agent, so they
never count as traffic. A failing check is retried once in the same run; a function is **down** after two failed runs
in a row and **degraded** after one, or when `/health` reports `warn` or a page is slow.
