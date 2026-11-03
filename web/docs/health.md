# Testing status.dliu.com

Machine-readable testing instructions for status.dliu.com, following the dliu.com health contract
(https://github.com/dliu-com/status/blob/master/HEALTH.md). The human version is the Testing tab, https://status.dliu.com/docs#health.

## Functions

| Key | Name | Critical | What it does |
| --- | --- | --- | --- |
| `pages` | Status board | yes | Serves the status page at `/`. |
| `checker` | Checker | yes | Scheduled Lambda that tests every site every 15 minutes and writes `/data/status.json`. |

## Guest checks

GET or HEAD only, no cookies, no `Authorization` header. Redirects are not followed.

| Function | Method | URL | Status | Content type | Body |
| --- | --- | --- | --- | --- | --- |
| `pages` | GET | `https://status.dliu.com/` | `200` | `text/html` | contains `dl-footer` |
| `checker` | GET | `https://status.dliu.com/data/status.json` | `200` | `application/json` | JSON object with key `generatedAt` (ISO 8601 time) no older than 30 minutes |

Slow threshold: 3 s. Timeout: 10 s.

## Health endpoint

None. The site's only backend is the scheduled checker (no HTTP endpoint). `/data/status.json` is written at the end of
every run, so a recent `generatedAt` proves the checker ran and could write to its storage. It is served with
`Cache-Control: public, max-age=60`.

`/data/status.json` format:

```json
{
  "generatedAt": "2026-11-03T23:00:00.000Z",
  "intervalMinutes": 15,
  "status": "up | degraded | down",
  "apps": [
    {
      "key": "video", "name": "DL video", "url": "https://video.dliu.com/", "docs": "https://video.dliu.com/docs/health",
      "status": "up", "detail": "All functions working", "since": "2026-11-03T22:00:00.000Z",
      "uptime": { "d1": 100, "d7": 100, "d30": 100, "d90": 100 },
      "days": [{ "date": "2026-11-03", "up": 96, "degraded": 0, "down": 0 }],
      "recent": [[1793833200, "u"]],
      "functions": [
        { "key": "pages", "name": "Pages", "critical": true, "status": "up", "detail": "Working",
          "checks": [{ "name": "GET / → 200", "status": "pass", "detail": "HTTP 200 in 120 ms", "ms": 120 }] }
      ]
    }
  ],
  "incidents": [{ "app": "video", "name": "DL video", "from": "up", "to": "down", "at": "…", "detail": "…" }]
}
```

## Not tested

Nothing on this site needs a sign-in.

## Rules

The tests are read only and never change anything.
