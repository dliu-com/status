# status

[status.dliu.com](https://status.dliu.com) tests every dliu.com site **as a guest**, every 15 minutes, and shows
which sites and which of their functions are up, degraded or down, with 90 days of history.

- **Guest only.** The checker never signs in and has no AWS access to the other sites. It requests public URLs over HTTPS,
  without cookies, like any visitor, plus each site's public `/health` endpoint.
- **Each site says how to test it.** Every site publishes a Health tab, `/docs#health` (for people: a diagram, technical details
  folded), and `/docs/health.md` (for machines: every detail). `config/apps.json` here is written from those pages. The
  contract every site follows is [`HEALTH.md`](HEALTH.md).
- **Four locations.** Ireland (the checker), Virginia and Tokyo (probe Lambdas) every 15 minutes, and mainland China
  hourly through [Globalping](https://globalping.io) (free, no account; 2 probes on China Telecom and China Unicom; each
  site's home page and `/health` only, about 40 tests an hour against the free 250). A check fails when most locations
  fail it; failing from one location only makes it degraded.
- **Not counted as traffic.** Every request uses the user agent `dliu-status-bot/1.0 (+https://status.dliu.com/docs)`,
  which traffic.dliu.com drops (and Globalping's `globalping probe …`).
- **Cost:** about $0.05 a month (limit: $1). See `/docs#cost`.

```
EventBridge rate(15 min) ──▶ Checker λ ──GET as guest──▶ <site>/…, <site>/health
                               │  state.json (streaks, 90-day history, incidents; private bucket)
                               └▶ data/status.json (public, 60 s cache) ◀── status.dliu.com (S3 + CloudFront)
```

## What counts as up, degraded or down

Each site in `config/apps.json` has **functions** (Pages, API, Sign-in, Docs…), and each function has **checks**.

| Check result | Meaning |
| --- | --- |
| pass | Expected status code, content type, body marker or JSON key, or redirect target, within 3 s |
| warn | Passed but slow (over 3 s), or `/health` reported `warn` |
| fail | Anything else, after one retry 2 s later in the same run (timeout 10 s) |

| Function | When |
| --- | --- |
| Up | Every check passed |
| Degraded | A check warned, or failed in this run only |
| Down | A check failed two runs in a row (`failuresBeforeDown`) |

A **site** is down when an essential function is down. It's degraded when any function isn't up; an optional function
(`"critical": false`, such as Docs) being down makes it degraded, never down. Availability counts degraded as available.
Sites marked `"private": true` (jh.dliu.com) are checked and kept in the private state, but left out of the public page
and `data/status.json`. cyy.dliu.com, link.dliu.com and home.dliu.com (removed) aren't checked.

When a site sets `"health": true`, the checker also reads `GET <site>/health` (see `HEALTH.md`). Each function it
reports joins the configured function with the same key, or appears as a new function. A missing or malformed `/health`
counts as an essential "Health endpoint" function failing.

## Changing the checks

1. `node scripts/import-health.js <key>` reads the site's `https://<site>/docs/health.md` and rewrites that site's
   functions and checks in `config/apps.json`. Review the diff: rules a table can't express need editing by hand
   (auth's `configured=true` and GUID checks use `jsonEquals` / `jsonPattern`).
2. Or edit `config/apps.json` by hand: a check is `{ "url", "method" (GET/HEAD), "expect": { "status", "type", "contains",
   "json", "jsonEquals", "jsonPattern", "location" }, "slowMs"?, "timeoutMs"?, "name"? }`.
3. `make check-local` runs every check from your machine and writes nothing.
4. `make deploy`.

## Deploy

Needs the DNS stack exports `MainDomain` / `MainHostedZoneId` and traffic-monitor's `TrafficVisitorFunctionArn` /
`TrafficGeoOriginRequestPolicyId` (or `-c trafficLogging=false`).

```bash
make install
make test       # type check + jest
make deploy     # stack "Status" in eu-west-1, then runs the checker once
make check      # run the checker in AWS now
make report     # every site's current status, private ones included
make outputs
```

## Layout

| Path | What |
| --- | --- |
| `config/apps.json` | The sites, their functions and checks |
| `lambda/checker/checks.js` | HTTP and `/health` requests and how each is judged |
| `lambda/checker/evaluate.js` | Up/degraded/down rules, history, incidents, the public file |
| `lambda/checker/index.js` | Lambda handler: reads state, runs checks, writes state and `data/status.json` |
| `lib/status-stack.ts` | CDK: private buckets, checker + schedule, CloudFront, certificate, DNS |
| `web/` | The status board, `/docs` (tabs: Architecture, Every check, Cost, Security, Health) and `/docs/health.md` |
| `HEALTH.md` | The testing contract every dliu.com site follows |
