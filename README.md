# express-crud

Minimal modular Express CRUD skeleton backed by PostgreSQL, with JWT authentication and per-user data, built to showcase observability: structured logs, OpenTelemetry traces and metrics, and a Grafana dashboard that ties them together. It's run like a production service too: validated config, health checks, graceful shutdown, rate limits and security headers.

## Requirements

- Node.js 22.9+
- Docker (for the local Postgres and Grafana), or any Postgres 13+ you point `DATABASE_URL` at

## Run

```bash
npm install
cp .env.example .env   # then set JWT_SECRET (the file shows how to generate one)
npm run up             # starts Postgres and Grafana in Docker
npm run db:migrate     # creates tables in the dev database
npm run dev            # readable logs; `npm start` writes JSON lines
```

Grafana is at **http://localhost:3001**. No account or login is needed: it runs entirely on your machine, with anonymous access switched on. (A Grafana account is only for Grafana Cloud, the hosted version, which this doesn't use.) The **express-crud** dashboard is under Dashboards → express-crud.

To run the app in its production Docker image instead of `npm run dev`, see [Docker](#docker).

Configuration is checked at startup. A bad or missing value, such as a short `JWT_SECRET`, stops the server with a list of every problem. All settings are listed in `.env.example` and under [Operations](#operations).

| Script | Does |
| --- | --- |
| `npm run up` / `down` | Start / stop Postgres and Grafana (`down` also stops the app container) |
| `npm run app:up` | Postgres, Grafana **and the app** in its Docker image (see [Docker](#docker)) |
| `npm run smoke` | Quick end-to-end check against a running server |
| `npm run db:up` / `db:down` | Postgres only (enough for `npm test`) |
| `npm run db:seed` | Adds 100,000 demo items (see [Tracing demo](#tracing-demo)) |
| `npm run load` | Generates traffic for the dashboard (see [Metrics](#metrics)). Set `RATE_LIMIT_ENABLED=false` first: it all comes from one IP. |
| `npm run start:no-telemetry` | Runs without OpenTelemetry loaded |
| `npm run start:zero-code` | Runs with zero-code instrumentation instead (see [Zero-code vs coded](#zero-code-vs-coded-instrumentation)) |

Postgres data lives in a Docker volume, so it survives restarts; `docker compose down -v` wipes it. Grafana's data lasts only as long as its container.

## Quick start

```bash
# Register (returns { user, token })
curl -X POST localhost:3000/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct-horse-battery"}'

# Use the token on item routes
curl localhost:3000/api/items -H "Authorization: Bearer <token>"
```

## Authentication

| Method | Path                 | Auth   | Does                                             |
| ------ | -------------------- | ------ | ------------------------------------------------ |
| POST   | /api/auth/register   | —      | Create a user; returns `{ user, token }`         |
| POST   | /api/auth/login      | —      | Returns `{ user, token }`                        |
| GET    | /api/auth/me         | Bearer | The current user                                 |

- **Tokens:** HS256 JWTs signed with `JWT_SECRET` via [`jose`](https://github.com/panva/jose), valid for 15 minutes (`JWT_EXPIRES_IN`). Send them as `Authorization: Bearer <token>`. There are no refresh tokens yet; log in again when one expires.
- **Passwords:** hashed with Node's built-in `scrypt` (N = 2^17, OWASP's recommendation). The parameters are stored with each hash, so the cost can be raised later without breaking existing passwords.
- **Emails** are trimmed, lowercased and unique regardless of case.
- **No user enumeration:** a wrong password and an unknown email get the same 401, in the same time.
- **Fresh on every request:** the token only identifies the user. Role and existence are checked in the database per request, so a deleted user or a removed admin role takes effect immediately.
- Every 401 has the same body and a `WWW-Authenticate: Bearer` header, whatever was wrong with the token.

### Ownership

Every item belongs to the user who created it. Users only ever see and change their own items; anything else returns **404**, exactly like an id that doesn't exist. Admins see and change everything. This is enforced in each SQL query's `WHERE` clause, not checked after fetching. Deleting a user deletes their items.

### Admins

There's deliberately no way to become an admin through the API. Create one, or promote an existing user:

```bash
npm run user:create-admin -- admin@example.com
```

It prompts for the password without echoing it (or reads `ADMIN_PASSWORD` for scripts). If the user already exists, it promotes them instead.

## Logging

Logs are JSON lines on stdout, written with [`pino`](https://getpino.io). Field names follow [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/), the same names traces use. With tracing on, every line logged during a request also has `trace_id` and `span_id`, and the same records are sent to Grafana's Loki, linked to their trace. `npm run dev` pipes them through `pino-pretty` for reading in a terminal (settings in `.pino-prettyrc`).

**One line per request**, written when the response finishes:

```json
{"level":"info","time":"2026-11-06T20:22:41.831Z","service.name":"express-crud","service.version":"1.0.0",
 "request_id":"6f1c2b0e-…","http.request.method":"GET","http.route":"/api/items/:id",
 "url.path":"/api/items/a92e03d8-…","http.response.status_code":200,"duration_ms":3.73,
 "user.id":"ee3c2a18-…","trace_id":"7d1828dc693f888e571d748653a828db","span_id":"401daf3c53218ff8",
 "msg":"GET /api/items/:id 200"}
```

| Field | Notes |
| --- | --- |
| `level` | From the status: 5xx is `error` (with `err` and its stack trace), 4xx is `warn`, everything else `info`. |
| `request_id` | Taken from an incoming `X-Request-Id` if it's 1–128 letters, digits, `_` or `-`; otherwise a new UUID. Always returned in the `X-Request-Id` response header. |
| `http.route` | The route pattern (`/api/items/:id`), for grouping. Absent when no route matched: 404s, malformed JSON, and requests rejected by auth before routing. |
| `url.path`, `url.query` | The actual URL. Sensitive query values are replaced with `REDACTED`: `q` (search text), `token`, `access_token`, `api_key`, `password`. |
| `trace_id`, `span_id` | Present when tracing is on. `trace_id` opens the request's trace in Grafana. |
| `user.id` | Present once the request is authenticated. |
| `duration_ms` | Time from arrival to response finished. |

Health checks (`/health/*`) aren't logged, since they would bury everything else.

**500s** return `{ "error": "Internal Server Error", "requestId": "…" }`. The client never sees internals, but can quote the id, which finds the exact log line with the full error.

**Events.** A few lines beyond requests, each with an `event.name`. Ones logged during a request carry its `request_id`.

| `event.name` | When |
| --- | --- |
| `server.started` | On startup, with port and log level |
| `user.registered` | A user registers |
| `auth.login_succeeded` | A login succeeds |
| `auth.login_failed` | A login fails, with `reason` (`wrong_password` or `unknown_email`) and `user.id` when the user exists |
| `db.pool.idle_client_error` | An idle Postgres connection errors (e.g. the database restarts) |

**What's never logged:**
- Request and response bodies and headers, so passwords, tokens and `Authorization` headers never reach the logs. As a backstop, fields named `password`, `passwordHash`, `token`, `authorization` or `cookie` are redacted if they're ever passed to the logger.
- Email addresses, including on failed logins. They're personal data, and people sometimes type a password into the email field.
- Search text. People type anything into a search box, so `q` is redacted from logged URLs.
- Objects attached to errors (a pg error otherwise carries its whole connection client), and Postgres's `detail` field, which can contain row values.

**Configuration:** `LOG_LEVEL` (default `info`; `.env.test` uses `silent`). Migration and admin scripts print plain text instead, since a person reads them.

## Tracing

Distributed tracing with [OpenTelemetry](https://opentelemetry.io), sent over OTLP to the Grafana stack that `npm run up` starts. Open Grafana at http://localhost:3001, go to **Explore**, pick **Tempo**, and search for service `express-crud`.

A login, as exported:

```
POST /api/auth/login                       376.5 ms   http.route=/api/auth/login  app.request_id=a09ca0fd-…
└─ request handler - /api/auth/login       375.2 ms
   ├─ pg-pool.connect                        0.2 ms
   ├─ pg.query:SELECT express_crud           1.2 ms   db.query.text=SELECT id, email, role, … FROM users WHERE lower(email) = lower($1)
   └─ auth.verify_password                 370.1 ms   auth.scrypt.cost=131072
```

### How it's set up

The setup and the instrumentation are kept apart, the split OpenTelemetry recommends:

- **Setup is a deployment concern.** [`src/instrumentation.js`](src/instrumentation.js) starts the SDK and chooses exporters and instrumentations. It's loaded with `node --import` before the app, and application code never imports it, so ops can replace or retune it without touching the app. All configuration uses the standard `OTEL_*` variables.
- **Instrumentation is an application concern.** App code imports only [`src/telemetry/tracing.js`](src/telemetry/tracing.js) and [`src/telemetry/metrics.js`](src/telemetry/metrics.js), which use `@opentelemetry/api` and never the SDK. With no SDK loaded, every call is a no-op, which is why `npm run start:no-telemetry` and the tests work unchanged.

**Automatic instrumentation** ([`src/telemetry/instrumentations.js`](src/telemetry/instrumentations.js)), four libraries rather than the ~40 the zero-code bundle enables:

| Instrumentation | Gives you |
| --- | --- |
| `http` | The server span per request: method, route, status, duration. Continues an incoming W3C `traceparent`. Health checks (`/health/*`) are skipped. |
| `express` | Spans for middleware and handlers. Express's internal layers and router layers are skipped as noise. |
| `pg` | A span per query with the SQL text (placeholders only), plus spans for waiting on a pool connection. |
| `pino` | `trace_id` / `span_id` on every log line, and log records sent to Loki. |

**Custom spans and attributes**, for what no library can see:

| Where | What | Why |
| --- | --- | --- |
| `auth.hash_password`, `auth.verify_password` | Spans with `auth.scrypt.cost` | scrypt runs on a background thread. Without these, a login is one 370 ms bar with nothing explaining it. |
| Request span | `user.id`, `user.roles` | Who made the request (set by the auth middleware) |
| Request span | `app.request_id` | A request id quoted from a 500 finds the trace as well as the log line |
| Request span (lists) | `app.search.query_length`, `app.list.filters`, `app.list.sort`, `app.list.page`, `app.list.limit`, `app.list.total` | Describes the search without recording its text |
| Request span (5xx) | Error status + `exception` event | The error handler turns exceptions into JSON responses, so no library sees the exception itself |

Request-level attributes go on the **request's server span**, not the active span. Inside middleware the active span is that middleware's own; the helper finds the server span the same way the Express instrumentation does to set `http.route`.

### Privacy

- **SQL parameter values are never recorded.** The pg instrumentation's `enhancedDatabaseReporting` is explicitly off: values include password hashes (register) and emails (login).
- **Search text is redacted** from `url.query` on spans, as in logs, along with credential-like parameters. This applies to outgoing requests too.
- **No bodies or headers** are recorded. A test checks that no span attribute, span event or exported log record contains a password, hash, token, email or search text.

### Behavior

- **Batched in the background.** Requests never wait on telemetry. With Grafana not running, data is dropped quietly and requests are unaffected.
- **Flushed on shutdown, last.** On Ctrl+C or `SIGTERM`, the app first finishes in-flight requests and closes the database pool (see [Graceful shutdown](#graceful-shutdown)). Only then does it flush telemetry, so the final requests' traces and logs are sent. The SDK setup publishes its flush function under a well-known global key, so app code can call it without importing the SDK. The flush is capped at 2 seconds, because with no collector the exporter would otherwise retry for about 9 seconds.
- **Metrics are set up explicitly** (see [Metrics](#metrics)). Without that, the SDK would quietly start exporting default metrics on its own, because an unset `OTEL_METRICS_EXPORTER` means `otlp`.

### Configuration

Standard OpenTelemetry variables, so pointing at another backend is configuration only:

| Variable | Default | |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Where traces and logs go |
| `OTEL_SERVICE_NAME` | `express-crud` | |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | Record everything | e.g. `parentbased_traceidratio` and `0.1` for 10% |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` | Milliseconds between metric exports (the OpenTelemetry default is 60000) |
| `OTEL_SDK_DISABLED` | `false` | `true` turns traces, metrics and log export off |
| `OTEL_LOG_LEVEL` | Silent | The SDK's own diagnostics, e.g. `debug` |

## Tracing demo

A walkthrough that shows tracing explaining a performance problem.

```bash
npm run db:seed    # 100,000 items for demo@example.com / demo-password
npm run dev
```

Log in as the demo user and run two searches:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s "localhost:3000/api/items?q=4242" -H "Authorization: Bearer $TOKEN" > /dev/null   # selective search
curl -s "localhost:3000/api/items?q=42"   -H "Authorization: Bearer $TOKEN" > /dev/null   # 2 characters
```

In Grafana, Explore → Tempo → TraceQL:

```
{ span.app.search.query_length < 3 }
```

Measured on the seeded data:

| Search | `app.search.query_length` | Matches | Request |
| --- | --- | --- | --- |
| `q=42424` | 5 | 1 | ~5 ms |
| `q=4242` | 4 | 20 | ~5 ms |
| `q=424` | 3 | 299 | ~6 ms |
| `q=42` | 2 | 3,970 | ~76–128 ms |
| `q=4` | 1 | 40,951 | ~67 ms |

Opening a slow trace shows the time is all in the two `pg.query` spans. The cause is that trigram indexes need at least 3 characters, so shorter searches scan the table. The fix is a product decision, such as a minimum search length or rate limiting, and the attribute makes these requests easy to find.

The seed script refuses to run against a non-local database unless given `--force`.

## Metrics

Metrics answer "is something wrong, and where?", cheaply and continuously. Traces and logs then explain why. They're exported over OTLP every 10 seconds, and Grafana's Prometheus stores them.

They follow two standard frameworks plus a few app-specific measurements:
- **RED** for requests: rate, errors, duration.
- **USE** for resources: utilization, saturation, errors.

### What's measured

**From the instrumentation, with no app code** (Prometheus names in brackets):

| Metric | Labels | Shows |
| --- | --- | --- |
| `http.server.request.duration` (`http_server_request_duration_seconds`) | method, `http.route`, status code | All of RED from one histogram: rate (its count), errors (5xx share), latency (quantiles), per route |
| `db.client.connection.count`, `.max`, `.pending_requests` | state (`used` / `idle`), pool name | Pool utilization and saturation. Requests waiting above 0 for long means the pool is the bottleneck. |
| `db.client.operation.duration` | operation | Query time, separately from request time |
| `nodejs.eventloop.utilization`, `nodejs.eventloop.delay.*` | — | Main-thread health: how busy it is, and how late timers fire |
| `v8js.memory.heap.used`, `v8js.gc.duration` | heap space, GC type | Memory and garbage-collection time |
| `process.cpu.utilization`, `system.cpu.utilization`, memory | CPU state | CPU, from `@opentelemetry/host-metrics` |

**Custom** ([`src/telemetry/metrics.js`](src/telemetry/metrics.js), API only like `tracing.js`):

| Metric | Labels | Why |
| --- | --- | --- |
| `app.auth.login.attempts` | `app.auth.outcome`: `success`, `wrong_password`, `unknown_email` | A spike in failures signals brute-forcing or credential stuffing |
| `app.auth.password_hash.duration` | `app.auth.operation`: `hash`, `verify` | Includes waiting for a libuv thread. Normal is ~0.3s, so seconds means logins are queueing. |
| `app.auth.password_hash.active` | `app.auth.operation` | Hashes in progress. Above 4, the default libuv pool size, calls are waiting. |
| `app.items.list.duration` | `app.search.category`: `none`, `short` (1–2 chars), `indexed` (3+) | Separates fast and slow searches, which share a route |
| `app.users.registered`, `app.items.created` | — | Is the app being used? |

**Label rule.** Each unique label combination is a separate time series stored forever. So labels only take values from small, fixed sets:
- route *patterns*, never URLs
- status codes
- categories, never the exact query length

User ids, request ids, emails, URLs and search text never become labels. Per-user and per-request detail belongs in traces and logs. A test sends varied traffic and fails if any metric carries one, or if request-duration series grow with the number of distinct URLs.

**Counters start at 0.** The server reports every counter at 0 on startup (`initMetrics()`). Otherwise a counter's series first appears already at its first value, and Prometheus's `rate()` needs to see an increase between two samples, so rare events like registrations would read as zero until they happened again.

### The dashboard

`npm run up` loads [`grafana/dashboards/express-crud.json`](grafana/dashboards/express-crud.json) into Grafana automatically (Dashboards → express-crud). A **Service** dropdown switches between `express-crud` and `express-crud-zero-code`.

| Row | Panels |
| --- | --- |
| Overview | Requests/s, server error share, p95 latency, process CPU |
| Requests | Rate by route, 4xx/5xx by status, p95 by route |
| Resources | CPU (process and machine), event loop, database pool, query p95, heap, GC |
| Application | Login outcomes, password hashing time, hashes in progress, list p95 by search kind, activity |
| Traces and logs | Slowest recent requests and short searches (Tempo tables; click a trace ID to open it), error logs (Loki) |

To change it, edit in Grafana, then export the JSON over the file. Grafana reloads it within 10 seconds.

**From a chart to a trace.** Ideally you'd click a point on a latency chart and open a trace from that moment. That uses *exemplars*, which the JavaScript SDK doesn't support yet. So the last row embeds trace searches instead: the slowest recent requests, and the short searches behind the "short" line.

### Load demo

```bash
npm run db:seed              # once
npm run dev
npm run load                 # mixed traffic: reads, searches, creates, logins, 4xx (60s)
npm run load -- --logins     # 20 parallel logins: password hashing as a bottleneck
```

Options: `--duration <seconds>`, `--concurrency <n>`, and `BASE_URL` to target another host.

**Turn rate limits off first** with `RATE_LIMIT_ENABLED=false` in `.env`, then restart the app. All load-test traffic comes from one IP, so with the default limits most requests get 429. The script says so if it sees that.

**What `--logins` shows.** Measured here on a 2-core machine, idle against 20 parallel logins:

| | Idle | 20 parallel logins |
| --- | --- | --- |
| Process CPU | 5% | 98% |
| Password hashes in progress | 0 | 5 (above the pool's 4, so queueing) |
| Password verify, median | 0.37 s | ~2 s |
| Login request, median | ~0.4 s | 3.1 s |
| Event loop utilization | 3% | under 5% |

At OWASP-recommended strength, each login costs about 0.37s of CPU, so a few per second fill both cores. Under mixed traffic, even simple item lists slowed from ~5ms to ~88ms median, because the main thread was waiting for CPU. The key signal is **high CPU with a quiet event loop**: the app isn't busy computing on the main thread, it's starved of CPU by work on other threads. Machines with more cores hit the limit later, but every machine hits it eventually. The options are more CPU, a lower scrypt cost, rate-limiting logins, or moving hashing to dedicated workers.

**The same test with the default rate limits on**, so the fix is visible on the dashboard:

| | Limits off | Limits on |
| --- | --- | --- |
| Logins that ran | 132 (median 3.7s) | 9, then 429s |
| Rejected requests | 0 | ~35,500, answered in ~11ms each |
| Peak process CPU | 99% | 51% |

With limits on, the "Rate-limited requests" panel lights up instead of the CPU panel. The 51% is the cost of answering about 1,400 rejections per second: refusing a flood is cheap, but not free. Most were stopped by the general `api` limit once the `auth` limit had refused the first few hundred.

### Suggested alerts

These are documented here rather than provisioned. Thresholds depend on your traffic.

| Alert | PromQL | Fires when |
| --- | --- | --- |
| Server errors | `sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m])) > 0.01` | Over 1% of requests fail, for 5 minutes |
| Slow requests | `histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m]))) > 0.5` | p95 above 500ms |
| Pool saturated | `sum(db_client_connection_pending_requests) > 0` | Requests are waiting for a connection, for 1 minute |
| Login failures spike | `sum(rate(app_auth_login_attempts_total{app_auth_outcome!="success"}[5m])) > 10 * sum(rate(app_auth_login_attempts_total{app_auth_outcome!="success"}[1d] offset 1d))` | Failures at 10x yesterday's rate |
| Password hashing queueing | `histogram_quantile(0.95, sum by (le) (rate(app_auth_password_hash_duration_seconds_bucket[5m]))) > 2` | Logins waiting seconds for a thread |

### How this was verified

Every Prometheus query on the dashboard was run against real data in Prometheus 3.4.2, the version the Grafana image uses, configured with the image's own settings. All of them returned data. The Tempo and Loki panels, and Grafana's loading of the dashboard file, weren't run, because Grafana itself couldn't be downloaded in the environment this was built in.

## Zero-code vs coded instrumentation

OpenTelemetry can be added two ways:

- **Zero-code**, which ops attaches at launch with no changes to the app's code.
- **Coded**, where the app includes OpenTelemetry setup and custom instrumentation.

This repo runs both on the same code, so you can compare them:

```bash
npm start                  # coded: src/instrumentation.js + custom spans
npm run start:zero-code    # zero-code: stock package, configured by .env.zero-code
```

Zero-code mode is pure configuration, the way ops would attach it:

```bash
node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
     --import @opentelemetry/auto-instrumentations-node/register src/server.js
```

[`.env.zero-code`](.env.zero-code) sets a separate service name (`express-crud-zero-code`) so both appear side by side in Grafana. Pick it in the dashboard's Service dropdown. It limits the bundle to the same libraries for a fair comparison (http, express, pg, pino, runtime-node). It also sets `APP_CUSTOM_TELEMETRY=false` to switch off this app's custom spans, attributes and metrics. That flag exists only for this comparison: in a real zero-code deployment there would simply be no custom code.

**The same login, both ways** (captured from real exports):

```
CODED                                              ZERO-CODE
POST /api/auth/login              376.5 ms         POST /api/auth/login              439.8 ms
└─ request handler                375.2 ms         ├─ middleware - query               0.0 ms
   ├─ pg-pool.connect               0.2 ms         ├─ middleware - expressInit         0.1 ms
   ├─ pg.query:SELECT               1.2 ms         ├─ middleware - requestLogger       0.2 ms
   └─ auth.verify_password        370.1 ms         ├─ middleware - jsonParser          0.6 ms
                                                   ├─ router - /register               0.0 ms
                                                   ├─ router - /register               0.0 ms
                                                   └─ request handler                438.0 ms
                                                      ├─ pg-pool.connect               0.2 ms
                                                      └─ pg.query:SELECT               1.4 ms
                                                         (436 ms unexplained)
```

Across the same five requests (register, login, create, search, a 500):

| | Coded | Zero-code |
| --- | --- | --- |
| Request spans, SQL spans, routes, status | ✓ | ✓ |
| `trace_id` on log lines, logs in Loki | ✓ | ✓ (needs the loader flag, see below) |
| Where login time goes | `auth.verify_password` | Unexplained |
| Who made the request (`user.id`) | ✓ | — |
| Search detail (`query_length`, filters, total) | ✓ | — |
| Request id on the trace | ✓ | — |
| 500: exception on the request span | ✓ | Status only; exception on child spans |
| Spans for the five requests | 33 | 60 (Express internals, misleadingly named router spans) |
| Health checks traced | No | Yes |

**Metrics, by dashboard panel** (both modes under the same load, against Prometheus):

| | Coded | Zero-code |
| --- | --- | --- |
| Request rate, errors, latency by route | ✓ | ✓ |
| Database pool, query duration | ✓ | ✓ |
| Event loop, heap, GC | ✓ | ✓ |
| CPU | ✓ | — (host metrics aren't in the zero-code bundle) |
| Login outcomes, password hashing, hashes in progress | ✓ | — |
| List latency by search kind | ✓ | — |
| Registrations, items created | ✓ | — |

Zero-code shows that latency rose and the pool is fine. It can't show that logins are queueing for scrypt threads, or that 2-character searches are the slow ones.

**The automatic part answers *what* is slow; the custom part answers *why*.**

**Gotchas found while building this:**
- **Zero-code on an ES module app needs the loader flag.** Without it, Express and pg still get spans (they're CommonJS packages), but pino isn't patched, so logs silently lose their `trace_id` and aren't exported.
- **Zero-code's `SIGTERM` handler only flushes. It doesn't exit.** Registering a signal handler disables Node's default exit, so on its own the process would keep running. This app now handles shutdown itself, so it exits cleanly either way. But an app without its own handler would hang on `SIGTERM` under zero-code. Its handler also doesn't flush on Ctrl+C.
- **The default resource detectors make cloud-metadata lookups** that time out with warnings outside that cloud. `.env.zero-code` limits them.
- **It exports protobuf by default** (`http/protobuf`). The coded setup sends JSON. Grafana's collector accepts both.

## Operations

What it takes to run this as a service, beyond the features.

### Configuration

Everything is read from environment variables, validated once at startup by [`src/config.js`](src/config.js) and [`src/auth/config.js`](src/auth/config.js). A bad value stops the process with every problem listed, rather than failing on the first request that needs it:

```
Invalid configuration:
  - PORT: Invalid input: expected number, received NaN
  - LOG_LEVEL: Invalid option: expected one of "trace"|"debug"|"info"|"warn"|"error"|"fatal"|"silent"
  - CORS_ORIGINS.1: Each origin must look like https://host[:port], with no path or trailing slash
```

A port that's already taken gets a one-line explanation too, not a stack trace. Blank values (`FOO=` in `.env`) mean "not set", so the default applies.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | `0` picks any free port. The real one is logged at startup. |
| `DATABASE_URL` | local Postgres | Must be a `postgres://` URL |
| `JWT_SECRET` | — | Required, 32+ characters |
| `LOG_LEVEL` | `info` | |
| `CORS_ORIGINS` | none | Comma-separated origins allowed from browsers, or `*` |
| `TRUST_PROXY` | `false` | Proxies in front of the app: `true`, a hop count, or addresses. Needed behind a load balancer, or every client shares the balancer's IP for rate limiting. |
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_WINDOW_MS` | `60000` | |
| `RATE_LIMIT_MAX` | `300` | All `/api` requests, per IP, per window |
| `RATE_LIMIT_AUTH_MAX` | `10` | Logins and sign-ups combined, per IP |
| `RATE_LIMIT_SHORT_SEARCH_MAX` | `20` | 1–2 character searches, per user |
| `DB_POOL_MAX` | `10` | |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | pg waits forever by default, so an unreachable database would hang every request |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | Postgres cancels slower statements. `0` disables. |
| `SHUTDOWN_DELAY_MS` | `0` | See below |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | See below |

Telemetry uses the standard `OTEL_*` variables (see [Tracing → Configuration](#configuration)).

### Health checks

| Endpoint | Answers | Fails when |
| --- | --- | --- |
| `GET /health/live` | Is the process up? | Never, while it can answer at all |
| `GET /health/ready` | Should it get traffic? Runs `SELECT 1` with a 2-second limit. | Database unreachable or slow (`503`, `{"status":"unavailable"}`), or shutting down (`503`, `{"status":"shutting_down"}`) |

`GET /health` still works, as an alias for liveness.

The split matters. Orchestrators restart an instance whose **liveness** fails, so liveness deliberately doesn't check the database: during a database outage, every instance would otherwise restart in a loop and come back no healthier. **Readiness** failing just takes the instance out of rotation until it passes again.

Health checks aren't logged, traced, rate limited or cached, since they run every few seconds. Instead, readiness logs once when it starts failing (`health.not_ready`, with the error) and once when it recovers (`health.ready`), not on every check.

### Graceful shutdown

On `SIGTERM` (a deploy, `docker stop`, Kubernetes) or `SIGINT` (Ctrl+C), [`src/main.js`](src/main.js):

1. **Fails readiness**, so load balancers stop sending new traffic.
2. **Waits `SHUTDOWN_DELAY_MS`**, still serving normally, while they notice. Load balancers take a few seconds to react, so in Kubernetes this is typically 5–10 seconds. It defaults to 0 locally.
3. **Stops accepting connections and lets in-flight requests finish.** Their responses carry `Connection: close`, so clients don't reuse a connection that's about to go away.
4. **After `SHUTDOWN_TIMEOUT_MS`, closes whatever is still running.** This is logged as `server.shutdown_timeout`, with how many requests were cut off.
5. **Closes the database pool, then flushes telemetry, and exits 0.**

A second signal exits immediately with code 1. Each stage is logged: `server.shutdown_started` (with how many requests were in flight), `server.stopped` (with how long it took).

**A detail that matters:** Node's `server.close()` waits for every connection, and keeps a finished request's keep-alive connection open for the next request. A request that was in flight at shutdown therefore held its connection open until the full timeout: a 0.4-second request made shutdown take 10 seconds. The app marks those responses `Connection: close` and closes each connection as soon as its request finishes.

**Behind a load balancer**, idle keep-alive connections are kept open for 65 seconds, longer than AWS ALB's 60. If the app closed first, the balancer could send a request on a connection being closed, and the client would see a 502.

### Crashes

An uncaught exception or unhandled promise rejection is logged at `fatal`, with its stack (`process.crashed`), flushed to Grafana, and the process exits 1 for the orchestrator to restart it. A process in an unknown state shouldn't keep serving, and without the log line a crash would look like an unexplained restart.

### When the database is unavailable

Errors that mean "the database can't be reached right now" become **`503 Service Unavailable` with `Retry-After: 5`**, not 500. Clients and load balancers treat 503 as temporary and retryable, while 500 says something is broken. They're matched in [`src/db/errors.js`](src/db/errors.js):
- connection refused, reset or timed out
- DNS failures
- statement timeouts
- Postgres shutting down
- too many connections

They're still logged at `error` with the full error, and traced as errors.

This showed up under load. With the CPU saturated by password hashing, opening a new database connection took longer than `DB_CONNECT_TIMEOUT_MS`, and those requests failed. The timeout is right, since before it they'd have waited indefinitely, but the status was wrong.

### Rate limiting

Three limits, using [`express-rate-limit`](https://github.com/express-rate-limit/express-rate-limit), each protecting something different:

| Limit | Applies to | Keyed by | Protects |
| --- | --- | --- | --- |
| `api` | Every `/api` request | Client IP | General flood protection |
| `auth` | Login and register, combined | Client IP | **CPU.** Each costs ~0.37s of scrypt, so a few per second saturate a small machine (see [Load demo](#load-demo)). Also slows brute-forcing. Malformed attempts count too. |
| `short_search` | 1–2 character searches only | User | The database: these can't use the trigram index and scan the table. 3+ character searches aren't limited. |

A rejected request gets `429` with standard headers:

```
RateLimit: "auth"; r=0; t=56
RateLimit-Policy: "auth"; q=10; w=60
Retry-After: 56
{"error":"Too many requests","limit":"auth","retryAfterSeconds":56}
```

Each 429 is recorded three ways:
- **Logs:** one request line at `warn`. There's deliberately no second line: doubling log volume during a flood would make things worse.
- **Metrics:** `app.rate_limit.rejections`, by limit, with its own dashboard panel. A spike in `auth` usually means brute-forcing.
- **Traces:** `app.rate_limit.limiter` on the request's span, and a span named after the limit that stopped it (e.g. `middleware - rateLimitAuth`).

Counters are kept in memory, per process. With several instances, each enforces its own limit. A shared store such as Redis, via `rate-limit-redis`, would make them global. Behind a proxy, set `TRUST_PROXY`, or every client is counted as the proxy's IP.

### Security headers and CORS

- **[`helmet`](https://helmetjs.github.io)** sets the standard headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Strict-Transport-Security`, a restrictive `Content-Security-Policy`, and no `X-Powered-By`. For a JSON API most matter little, but they cost nothing.
- **CORS** is off unless `CORS_ORIGINS` lists origins, so browsers block cross-origin calls by default. Listed origins may send `Authorization`, `Content-Type`, `X-Request-Id` and `traceparent` (so a browser app's traces join the API's). They may read `X-Request-Id` and the rate-limit headers. Tokens travel in the `Authorization` header, not cookies, so credentials mode isn't needed.
- **Bodies over 100kb** are rejected with `413`.
- **Requests taking over 30 seconds** are abandoned (Node's default is 5 minutes).

## Docker

The [`Dockerfile`](Dockerfile) builds a production image:

```bash
npm run app:up      # builds the image, then starts Postgres, Grafana and the app
npm run smoke       # checks it works end to end
npm run app:logs    # follow its logs
npm run down        # stops everything
```

The app is then at `localhost:3000`, so stop `npm run dev` first. `app:up` reads `JWT_SECRET` (and `RATE_LIMIT_ENABLED`, `LOG_LEVEL`) from your `.env`, runs migrations, and waits until the app's healthcheck passes. Inside Docker, the app reaches Postgres and Grafana by service name (`postgres`, `lgtm`) rather than `localhost`, which `docker-compose.yml` sets.

**What's in the image, and why:**
- **Production dependencies only.** They're installed in a separate build stage, so npm's cache and the dev tools never reach the final image: test libraries, `pino-pretty`, and the zero-code bundle. That's about 62MB of `node_modules`. Install scripts are skipped: no dependency needs one, and skipping them stops a compromised package from running code at build time.
- **Runs as the unprivileged `node` user, over root-owned files**, so a compromised process can't modify its own code.
- **Node is PID 1**, started directly rather than through npm or a shell. It receives `docker stop`'s SIGTERM and shuts down gracefully. npm doesn't reliably forward signals, and a shell wouldn't forward them at all. Compose's `stop_grace_period` (15s) is longer than `SHUTDOWN_TIMEOUT_MS` (10s), so in-flight requests finish before Docker resorts to SIGKILL.
- **`HEALTHCHECK` uses readiness** (`/health/ready`), so "healthy" means "can serve", database included. Docker only reports health. Kubernetes, which acts on it, should use `/health/live` for liveness and `/health/ready` for readiness.
- **Migrations run on container start** in Compose, for convenience. In production, run them as a separate release step, so a failed migration doesn't crash-loop every instance: `docker compose run --rm app node scripts/migrate.js`.

To build and run the image on its own:

```bash
docker build -t express-crud .
docker run -p 3000:3000 -e JWT_SECRET=... -e DATABASE_URL=postgres://... express-crud
```

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull request, as two parallel jobs:

| Job | Does |
| --- | --- |
| **Tests** | `npm test` against a real Postgres 16 (a GitHub Actions service container): the whole suite, including the real-process shutdown tests |
| **Docker image** | Builds the image (layers cached between runs), starts it with Postgres through Compose, and waits for its healthcheck. Runs `scripts/smoke.js` against it, checks it logs JSON with request ids, then stops it and checks it shut down gracefully (exit code 0, `server.stopped` logged). |

The workflow can only read the repository: no secrets, no pushing, no publishing. The JWT secret is generated fresh for each run, and fork pull requests are safe to run. A newer push to the same branch cancels the run it replaces.

To show the status on GitHub, add a badge to the top of this README, replacing `OWNER/REPO`:

```markdown
![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)
```

**Checked before publishing:** the workflow passes [`actionlint`](https://github.com/rhysd/actionlint), including `shellcheck` on every `run:` step. The image's install and run were reproduced without Docker, and passed:
- production dependencies only, with the same flags
- running as an unprivileged user
- migrations on a fresh database
- the healthcheck command and smoke test
- a graceful SIGTERM

The image itself and the workflow haven't been run, because Docker and GitHub Actions weren't available where this was built. The first push to GitHub is their first real run.

## Testing

```bash
npm test             # runs migrations on the test DB, then the suite
npm run test:watch
```

Tests run against a real Postgres database, `express_crud_test` (configured in `.env.test`), so they never touch dev data. `npm run db:up` must be running first. `.env.test` also lowers the scrypt cost so the suite stays fast.

Uses Node's built-in test runner (`node:test`) and `supertest`, which calls the app in-process without opening a port. Test files run one at a time (`--test-concurrency=1`) because they share the test database.

```
test/
  helpers.js                  # api(token?), anon(), registerUser(), createItem(), seed(), resetStore()
  app.test.js                 # health, 404s, malformed JSON
  errorHandler.test.js        # 500s hide internals and return the request id
  auth.test.js                # register, login, /me, every kind of rejected token
  items.crud.test.js          # create/read/update/delete, timestamps, stripped keys
  items.validation.test.js    # body, params and query validation
  items.list.test.js          # pagination and sorting
  items.filter.test.js        # search, price/date filters, combined with paging, ownership
  items.ownership.test.js     # per-user isolation, admin access, cascade delete
  logging.test.js             # request ids, request lines, levels, events, redaction
  tracing.test.js             # span structure, custom spans, errors, propagation, log correlation, privacy
  metrics.test.js             # custom and automatic metrics, label cardinality guard
  operations.test.js          # config, health checks, security headers, CORS, rate limits, 503s
  shutdown.test.js            # real server process: graceful shutdown, crashes, startup errors
  support/instrumentation.js  # test SDK setup: same instrumentations, telemetry kept in memory
  support/metricsProbe.js     # fresh process for startup-metrics tests
```

`shutdown.test.js` starts the real server as a separate process on a free port (`PORT=0`), sends it signals and checks what clients got and how it exited.

Logging tests build an app with `createApp({ logger })`, using a logger that writes to memory, so they can check the actual log lines.

`npm test` loads `test/support/instrumentation.js` with `--import`: the same instrumentations and options as the real setup, but spans and log records go to in-memory exporters and metrics are read on demand, so tests inspect real telemetry with nothing sent over the network. Metrics are cumulative within a test file, so metric tests compare values before and after the requests they make.

Only `*.test.js` files are run, so `helpers.js` isn't mistaken for a test file.

Each test starts from empty tables with a freshly registered default user (`resetStore` in `beforeEach`); `api()` sends that user's token automatically.

## Database

- **Driver:** plain [`pg`](https://node-postgres.com) with parameterized SQL, no ORM.
- **Migrations:** `src/db/migrations/*.sql` run in filename order by `scripts/migrate.js`, each in a transaction, tracked in a `schema_migrations` table. To change the schema, add a new numbered file (e.g. `005_add_category.sql`); never edit one that has already run.
- **Columns:** stored as `snake_case`, returned as `camelCase` (`created_at AS "createdAt"`).
- **Safety:** values always go through placeholders (`$1`). Column names can't, so sort and update columns come from allowlists in the service.

## Structure

```
src/
  instrumentation.js        # OpenTelemetry SDK setup, loaded with --import (never imported by the app)
  server.js                 # entry point: short messages for config errors and busy ports
  main.js                   # starts the server; graceful shutdown; crash handling
  app.js                    # createApp(): middleware and route mounting
  config.js                 # all settings, validated at startup
  lifecycle.js              # shutdown state (readiness reads it)
  healthPaths.js            # which paths are health checks (skipped by logs, traces, limits)
  telemetry/
    tracing.js              # app-side tracing (API only): spans, request attributes
    metrics.js              # app-side metrics (API only): custom counters and histograms
    shutdown.js             # flushes telemetry before exit, without importing the SDK
    instrumentations.js     # which libraries are instrumented and how (setup side)
  auth/
    config.js               # validates JWT_SECRET etc. at startup
    password.js             # scrypt hashing and verification
    tokens.js               # JWT sign/verify
  logging/
    logger.js               # pino logger: field names, redaction, error serializer
    requestId.js            # validate or generate X-Request-Id
    httpLogger.js           # one log line per request
    redaction.js            # query params redacted in logs and spans
  db/
    pool.js                 # pg connection pool + query(), with timeouts
    errors.js               # which errors mean "database unavailable" (-> 503)
    migrations/             # numbered .sql migrations
  routes/
    index.js                # registers all routers under /api
    health.routes.js        # /health/live, /health/ready
    auth.routes.js          # /api/auth endpoints
    item.routes.js          # /api/items endpoints (all require auth)
  controllers/
    auth.controller.js
    item.controller.js
  services/
    user.service.js         # SQL for users (never returns password hashes, except for login)
    item.service.js         # SQL for items: ownership + filters in one WHERE builder
  schemas/
    auth.schema.js          # zod schemas for register/login
    item.schema.js          # zod schemas for params/query/body
  middleware/
    authenticate.js         # Bearer token -> req.user
    errorHandler.js         # 404 + error handler (5xx hide internals, return the request id; 503 when the DB is down)
    rateLimit.js            # the api, auth and short_search limits
    security.js             # helmet headers and CORS
    validate.js             # generic zod validation middleware
  utils/
    httpError.js            # error with an HTTP status
scripts/
  migrate.js                # migration runner
  create-admin.js           # create or promote an admin
  seed.js                   # demo data for the tracing demo
  load.js                   # traffic generator for the dashboard
  smoke.js                  # end-to-end check against a running server (used by CI)
grafana/
  dashboards/express-crud.json  # the dashboard, loaded by Grafana on startup
  provisioning/dashboards.yaml  # tells Grafana where to find it
docker/initdb/              # runs on first Postgres start (creates test DB)
.github/workflows/ci.yml    # tests + Docker image build and smoke test
Dockerfile                  # production image
.dockerignore               # keeps node_modules and .env out of builds
.env.zero-code              # configuration for `npm run start:zero-code`
```

Invalid requests get a `400` with every issue listed:

```json
{ "error": "Validation failed",
  "details": [{ "location": "body", "path": "name", "message": "..." }] }
```

## Item endpoints

All require `Authorization: Bearer <token>`.

| Method | Path             | Action                 |
| ------ | ---------------- | ---------------------- |
| GET    | /health/live     | Liveness (no auth, see [Health checks](#health-checks)) |
| GET    | /health/ready    | Readiness: checks the database |
| GET    | /api/items       | List, filter and search items (paginated) |
| GET    | /api/items/:id   | Get one item           |
| POST   | /api/items       | Create item            |
| PUT    | /api/items/:id   | Update item            |
| DELETE | /api/items/:id   | Delete item            |

## Pagination & sorting

`GET /api/items?page=2&limit=5&sort=price&order=desc`

| Param   | Default     | Allowed                         |
| ------- | ----------- | ------------------------------- |
| `page`  | `1`         | integer ≥ 1                     |
| `limit` | `20`        | integer 1–100                   |
| `sort`  | `createdAt` | `createdAt`, `name`, `price`    |
| `order` | `asc`       | `asc`, `desc`                   |

Items missing the sort field (e.g. no `price`) always appear last. Ties are broken by creation time, then id, so paging is stable.

## Filtering & search

`GET /api/items?q=lamp&minPrice=10&maxPrice=50&createdAfter=2026-11-01&sort=price`

| Param           | Matches                                         | Notes                                                                 |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `q`             | name **or** description contains the text       | Case-insensitive, partial words match, up to 100 characters. `%` and `_` are literal. |
| `minPrice`      | price ≥ value                                   | Items with no price never match a price range.                        |
| `maxPrice`      | price ≤ value                                   |                                                                       |
| `hasPrice`      | `true` / `false`                                | `false` finds unpriced items.                                         |
| `createdAfter`  | created at or after (inclusive)                 | `YYYY-MM-DD` (midnight UTC) or an ISO timestamp with a timezone.      |
| `createdBefore` | created before (exclusive)                      | Back-to-back ranges never count an item twice.                        |
| `ownerId`       | items belonging to that user                    | For admins. For anyone else it only ever narrows their own items.     |

- Filters are optional and combine with AND. Sorting, paging and `meta.total` apply to the filtered results.
- A blank value (`?q=`, `?minPrice=`) means "not given", since forms and search boxes often send them.
- Invalid values get a 400, e.g. `minPrice` greater than `maxPrice`, `hasPrice=yes`, or a timestamp without a timezone.
- Filters only narrow what you can already see: searching never reveals another user's items.

The response echoes the applied filters, normalized:

```json
{
  "data": [ { "id": "…", "name": "Desk lamp", "description": null, "price": 25, "ownerId": "…", "createdAt": "…", "updatedAt": "…" } ],
  "meta": {
    "page": 1, "limit": 20, "total": 3, "totalPages": 1, "sort": "price", "order": "asc",
    "filters": { "q": "lamp", "minPrice": 10, "maxPrice": 50, "createdAfter": "2026-11-01T00:00:00Z" }
  }
}
```

**Performance.** Search uses substring matching (`ILIKE '%text%'`) backed by `pg_trgm` trigram indexes, and price ranges have a B-tree index. On 1M rows, a search takes ~9 ms with the index against ~330 ms without. Searches of 1–2 characters are too short for trigrams and fall back to a full scan (~400 ms at 1M rows). The Compose file sets `random_page_cost=1.1` (the usual SSD value); with Postgres's spinning-disk default, the planner skips the search indexes on tables of around 100k rows.

`id`, `ownerId`, `createdAt` and `updatedAt` are set by the server; clients can't overwrite them.

## Adding a resource

1. Add a migration in `src/db/migrations/` for its table (with an `owner_id` if it's per-user).
2. Create `schemas/<name>.schema.js`, `services/<name>.service.js`, `controllers/<name>.controller.js`, `routes/<name>.routes.js`. Copy the item files, including:
   - `router.use(authenticate)`
   - `recordRoute` as each route's first handler, so error log lines get the full route
   - the `buildWhere` ownership pattern
3. Register it in `routes/index.js`: `router.use('/<name>s', create<Name>Routes({ limiters }));`
