# solidcommunity.net recovery alpha.1

This branch backports the CSS changes used by the stable single-worker
`solidcommunity.net` deployment onto Community Solid Server 7.1.9.

## Included fork pull requests

- Correctness and bounded-resource fixes: #52, #55, #68, #75, #77, #79,
  #86, and #87.
- Hot-path improvements: #31, #49, #58, #59, #90, #101, #103, and #105.
- Container listing streaming from upstream PR #2211, including cleanup when a
  consumer closes an unread listing.
- Write-lock renewal from upstream PR #2217 and dedicated persistent OIDC
  client-registration storage from upstream PR #2218.
- The extension-mapper lookup optimization deployed on `solidcommunity.net`.
- Bounded in-memory lock acquisition, reader-count rollback when acquisition
  fails, and preservation of readable-stream identity while renewing locks.

The Redis changes (#68, #75, and #77) were present in the deployed build but
remain inactive when the normal single-worker file configuration uses its file
resource locker.

The two OIDC adapter storages are named independently. Deployments can override
`IdpAdapterExpiringStorage` with memory storage while leaving
`IdpClientAdapterExpiringStorage` persistent, so dynamic client registrations
survive restarts without persisting high-frequency transient provider state.

## Deliberate exclusions

- #113 was investigated after the stable recovery build and is not required for
  its measured latency improvement.
- #114 was deployed experimentally and rolled back. Its container-size check
  made ActivityPub inbox writes O(n) and caused a large CPU and latency
  regression.
- The experimental converted-representation cache remains disabled; it was not
  part of the measured stable configuration.

## Normal CSS performance configuration

The core ACL cache is part of this branch. The measured read-cache improvement
is supplied by `@jeswr/css-cached-storage` and can also be used with an otherwise
normal CSS 7.x installation. Install that package, then start CSS with
`config/solidcommunity-performance.json`.

The cache is deliberately read-only (`maxWriteQueueSize` and
`maxWriteQueueFileSize` are zero) so writes remain durable before CSS responds.
It is single-worker only: do not combine this configuration with `--workers`
greater than one because the in-memory cache is not coherent across workers.
