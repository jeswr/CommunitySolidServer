# Production deployment

This guide covers running the Community Solid Server (CSS) in production: persistent storage, HTTPS, process
supervision, containers, health checks, logging, scaling, hardening, and backups. It assumes you already know how to
start the server (see [Starting the server](starting-server.md)).

## Choosing a configuration

The default configuration (`@css:config/default.json`) stores everything in memory and is wiped on restart, which is
fine for demos but not for production. For a persistent single-instance deployment, use the file-based storage
configuration:

```shell
community-solid-server -c @css:config/file.json -f /var/lib/css/data --baseUrl https://your.domain/
```

The parameters that matter most in production:

- `--config, -c` (env `CSS_CONFIG`): pick `@css:config/file.json` for on-disk storage instead of the memory default.
- `--rootFilePath, -f` (env `CSS_ROOT_FILE_PATH`): the directory where the file backend keeps all data. Put this on
  durable, backed-up storage.
- `--baseUrl, -b` (env `CSS_BASE_URL`): the public URL clients reach the server at. This value is baked into generated
  URLs, WebIDs, and OIDC metadata, so it must match the address users actually use (including scheme and any path).

Any parameter can also be supplied as an environment variable prefixed with `CSS_` and converted from `camelCase` to
`SCREAMING_SNAKE_CASE` (for example `--baseUrl` becomes `CSS_BASE_URL`). Command-line arguments override environment
variables.

## HTTPS and the reverse proxy

The recommended production shape is to run CSS behind a TLS-terminating reverse proxy (nginx, Caddy, or a cloud load
balancer) and let the proxy handle certificates. Point the server at its public HTTPS address:

```shell
community-solid-server -c @css:config/file.json -f /var/lib/css/data --baseUrl https://your.domain/
```

The proxy must forward the original `Host` header and the `X-Forwarded-*` headers (`X-Forwarded-Proto`,
`X-Forwarded-Host`, `X-Forwarded-For`) so the server can reconstruct request URLs correctly. A minimal nginx location
block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

As an alternative, CSS can terminate TLS itself using its direct-HTTPS server factory. The config that enables this
adds `--httpsKey` and `--httpsCert` CLI options (see `config/https-file-cli.json`); a config-level variant that sets
the key and certificate paths directly is shown in `config/example-https-file.json`. A reverse proxy is still usually
preferable because it centralizes certificate management, HTTP/2, and rate limiting.

## Running as a supervised process

The server handles `SIGINT` and `SIGTERM` for graceful shutdown: on receiving the signal it stops accepting new
connections, drains in-flight requests, runs its finalizers (flushing state and closing backends), and allows up to a
30-second grace period before forcing exit. Because of this you should run CSS under a process supervisor that sends
`SIGTERM` on stop and restarts the process on failure — systemd or a container runtime both work well.

### systemd

A minimal unit file:

```ini
[Unit]
Description=Community Solid Server
After=network.target

[Service]
User=css
WorkingDirectory=/opt/css
ExecStart=/usr/bin/node bin/server.js -c config/file.json -f /var/lib/css/data --baseUrl https://your.domain/
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`systemctl stop` sends `SIGTERM`, which stops the server cleanly through the graceful-shutdown path above, so no
special `KillSignal` or `KillMode` tuning is required. Adjust `WorkingDirectory` and the `ExecStart` path to wherever
you installed the server, and make sure `User=` owns `--rootFilePath`.

## Docker

The image runs as a non-root user (uid 1000) under `tini` as PID 1 (for correct signal forwarding and zombie
reaping) and ships with a `HEALTHCHECK`. Mount a volume for the data directory and set the base URL:

```shell
docker run --rm \
  -p 3000:3000 \
  -v /srv/css-data:/data \
  -e CSS_CONFIG=config/file.json \
  -e CSS_ROOT_FILE_PATH=/data \
  -e CSS_BASE_URL=https://your.domain/ \
  solidproject/community-server:latest
```

The mounted volume must be writable by uid 1000, since that is the user the container runs as. On a host directory,
`chown 1000:1000 /srv/css-data` (or the equivalent) before starting.

A `docker-compose.yml` snippet with a health check:

```yaml
services:
  css:
    image: solidproject/community-server:latest
    ports:
      - "3000:3000"
    volumes:
      - ./css-data:/data
    environment:
      CSS_CONFIG: config/file.json
      CSS_ROOT_FILE_PATH: /data
      CSS_BASE_URL: https://your.domain/
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/.well-known/css/health"]
      interval: 30s
      timeout: 5s
      retries: 3
    restart: unless-stopped
```

## Health checks

The server exposes a liveness endpoint:

```shell
curl https://your.domain/.well-known/css/health
```

It returns `200` with body `{"status":"ok"}`. This check is intentionally cheap — it does not touch storage — so it is
safe to poll frequently. Wire it into your orchestration:

- Kubernetes: use it for both `livenessProbe` and `readinessProbe`.
- ELB/ALB or another load balancer: use it as the target health check path.
- Docker Compose: use it in the `healthcheck` block (see the snippet above).

## Logging

Two settings control log output:

- `--loggingLevel, -l` (env `CSS_LOGGING_LEVEL`, default `info`): the verbosity. Use `debug` only for troubleshooting;
  it is noisy and slower.
- `--loggingFormat` (env `CSS_LOGGING_FORMAT`): set to `json` to emit one JSON object per line instead of
  human-readable text.

JSON output is the right choice when shipping to a log aggregator such as CloudWatch, Loki, or ELK. Each log line
carries a per-request id, and for authenticated requests it additionally includes the WebID, the client id, and the
token id, so you can correlate all log entries belonging to a single request or session.

CSS writes to stdout/stderr; do not have it manage log files itself. Let your platform capture stdout — journald under
systemd, or the Docker json-file/journald logging driver — and forward it to your aggregator.

```shell
community-solid-server -c @css:config/file.json -f /var/lib/css/data \
  --baseUrl https://your.domain/ --loggingFormat json --loggingLevel info
```

## Workers and scaling

`--workers, -w` (env `CSS_WORKERS`) controls multi-process mode:

- `1` (default): single-threaded, one process.
- `-1`: scale to `num_cores - 1` workers.
- `0`: scale to `num_cores` workers.

The in-memory storage configuration cannot run with more than one worker: it fails fast at boot, because each worker
would hold its own copy of the data. To run multiple workers (or multiple machines) you need a shared backend. That
means the file backend combined with a shared resource locker instead of the default in-memory locker: CSS ships a
Redis-based locker at `config/util/resource-locker/redis.json`, which lets multiple workers/instances coordinate
writes against the same storage.

Note that cross-instance notifications are a known limitation: subscriptions handled by one instance are not
propagated across the others. The safest options are:

- a single single-worker instance, or
- several single-worker instances behind a reverse-proxy load balancer, all sharing the same file storage and Redis
  locker, with the notification limitation understood.

## Hardening

Several defenses are configured at the config level, in the server-factory and body-parser blocks, rather than through
CLI flags. Review these before exposing the server publicly:

- **Request body size limits:** cap the size of request bodies to prevent a single large upload from exhausting memory
  or disk. This is a parameter on the body-parsing configuration.
- **HTTP server timeouts:** the server factory exposes `requestTimeout`, `headersTimeout`, `keepAliveTimeout`, and
  `maxConnections`. Setting `headersTimeout`/`requestTimeout` protects against slowloris-style attacks that hold
  connections open by trickling bytes; `maxConnections` bounds total concurrent sockets. Tune these in the
  server-factory config (see `config/http/server-factory/`).
- **Security response headers:** the server sends `X-Content-Type-Options`, `Referrer-Policy`, and
  `X-Frame-Options` by default, so no extra work is needed to get these.

Because these are config parameters rather than CLI flags, adjust them by editing (or importing and overriding) the
relevant entries in your configuration; the config files above list the exact parameter names.

## Fast startup (optional)

Cold boot can be slow because CSS assembles its dependency graph with Components.js at startup. Two opt-in speed-ups
can cut cold-boot time substantially:

- `--moduleStateCachePath`: caches the resolved module state so it does not have to be recomputed on every boot.
- `--precompiledConfigPath`: caches a precompiled configuration so the dependency-injection graph does not have to
  be re-resolved on every boot.

Both are optional optimizations, most useful where startup latency matters (frequent restarts, autoscaling, CI).

## Backups

With the file backend, all state lives under `--rootFilePath`. That tree contains both the pod data and a
`/.internal/` directory holding accounts, OIDC signing keys, client-credential secrets, tokens, and notification
channel records. Back up the entire `rootFilePath` tree — backing up only the visible pod data would lose accounts and
keys.

Writes are atomic (data is written to a temp file and renamed into place), so a cold copy taken while the server is
stopped is internally consistent. For a backup taken while the server is running, prefer a filesystem-level snapshot
(LVM, ZFS, EBS snapshot, etc.) over a plain recursive copy to avoid capturing a partially written state.

> **Warning:** `/.internal/` contains secrets, including the OIDC signing keys and client-credential secrets. Anyone
> with the backup can impersonate the server and its users, so protect backup confidentiality (encryption at rest,
> restricted access) the same way you would protect a private key.

## Memory sizing

For the file backend, the Node.js process uses roughly a few hundred MB of RSS at idle, growing with concurrent
request load. Exact numbers depend on your workload, so measure against your own traffic rather than provisioning to a
fixed figure. General guidance:

- Allocate comfortable headroom above the idle footprint for request spikes.
- Always run under a supervisor that restarts on failure (see the systemd and Docker sections), so a rare
  out-of-memory kill self-heals.
- On memory-constrained hosts, consider bounding the V8 heap with `--max-old-space-size` (a Node.js flag) so the
  process fails predictably instead of pushing the host into swap.

## CORS

CSS reflects any request origin and allows credentials by design. This is intentional for Solid: applications are
arbitrary third-party origins, and security comes from DPoP-bound tokens and Web Access Control (WAC/ACP), not from
CORS restrictions. Do **not** try to "lock down" CORS to specific origins — doing so breaks legitimate Solid apps
without adding real protection.

## Production checklist

- [ ] Persistent configuration selected (`@css:config/file.json`, not the memory default).
- [ ] `--baseUrl` set to the exact public URL clients use.
- [ ] HTTPS in place, via a TLS-terminating reverse proxy (forwarding `Host`/`X-Forwarded-*`) or direct HTTPS.
- [ ] Process supervised (systemd or a container runtime) with restart-on-failure and clean `SIGTERM` shutdown.
- [ ] Health probe `/.well-known/css/health` wired into your orchestrator/load balancer.
- [ ] JSON logging enabled and stdout shipped to your aggregator.
- [ ] Body size limits and HTTP server timeouts configured (slowloris protection).
- [ ] Backups of the whole `rootFilePath` tree, including `/.internal/` secrets, with confidentiality protected.
- [ ] Scaling caveats understood: memory config is single-worker only; multi-worker/multi-instance needs a shared
      backend and Redis locker, with cross-instance notifications still limited.
