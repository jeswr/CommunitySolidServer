# Scaling, clustering and locking

The Community Solid Server serializes concurrent writes to the same resource with a *resource locker*.
Which locker is safe to use depends on how you scale the server:
in a single process, across multiple worker threads, or across multiple server instances.
Choosing the wrong locker can silently corrupt data, so this page describes the trade-offs.

## Ways of running the server

There are two independent axes of scaling:

* **Workers / clustering** (single machine, one storage backend):
  the `--workers`/`-w` parameter runs the server in multithreaded mode using the
  Node.js [`cluster`](https://nodejs.org/api/cluster.html) module.
  See [Starting the server](starting-server.md) for the exact semantics of the values.
  With more than one worker, several processes handle requests against the *same* backend.
* **Multiple instances** (horizontal scaling):
  running several independent server processes (for example several containers or Kubernetes replicas)
  that all point at the *same* shared storage.

Both cases mean that more than one process can write to the same resource at the same time,
so the locker has to coordinate *across processes*, not just within one.

## The in-memory locker is single-instance only

The default configuration (`config/default.json`) and every configuration that imports
`config/util/resource-locker/memory.json` use the `MemoryResourceLocker`.
This locker keeps all of its locks in the memory of a *single* process.

!!! danger "The in-memory locker is not shared across processes"
    Because the locks only live in the memory of one process, a second worker or a second
    server instance does not see them. Two processes can then acquire a "lock" on the same
    resource at the same time and write to it simultaneously, which can corrupt that resource
    and its metadata. The in-memory locker is therefore only correct for a **single process,
    single instance** deployment.

The default configuration also stores all data *in memory* (`config/storage/backend/memory.json`),
so it cannot be scaled horizontally anyway; it is intended for development and quickly trying things out.
The risk becomes relevant when the in-memory locker is combined with a **persistent backend**
(a file or SPARQL backend) that *can* be shared between processes or instances.

### What the server does to protect you

* **Clustering is refused.**
  The `MemoryResourceLocker` is marked as single-threaded. When the server is started with more than
  one worker (`--workers` set to anything other than `1`) while a single-threaded component such as the
  in-memory locker is configured, startup is aborted with an error rather than running in an unsafe state.
* **A warning is logged.**
  In addition, the `MemoryResourceLocker` logs a `warn`-level message at startup when it detects it is
  being constructed in multithreaded/clustered mode, pointing you at a shared locker.
  A normal single-instance, single-worker deployment sees no warning and no change in behaviour.

!!! warning "Multiple instances cannot be detected automatically"
    The checks above catch the multi-*worker* case within one process. They cannot detect that you
    started several *separate* single-worker instances against the same shared storage
    (for example several containers on a network file system). In that setup every instance passes
    the single-threaded check individually, yet their in-memory locks are still not shared.
    When you run more than one instance you **must** switch to a shared locker yourself.

## Choosing a locker

| Locker                                       | Safe for                                              | Notes                                                                                     |
|----------------------------------------------|-------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `config/util/resource-locker/memory.json`    | Single process, single instance                       | Default. Fastest, but locks are not shared across processes.                              |
| `config/util/resource-locker/file.json`      | Multiple workers/instances on one shared file system  | Process- and thread-safe. Relies on the file system for locking (see caveat below).       |
| `config/util/resource-locker/redis.json`     | Multiple instances across machines                    | Recommended for horizontal scaling. Requires a reachable Redis server.                    |

To use a different locker, start from a configuration that imports the corresponding
`config/util/resource-locker/*.json` file instead of the in-memory one, or override that import in your
own configuration. See the [configuration documentation](https://communitysolidserver.github.io/configuration-generator/)
and [`config/README.md`](https://github.com/CommunitySolidServer/CommunitySolidServer/blob/main/config/README.md)
for how imports are composed.

!!! note "File-system locking on network storage"
    The file locker coordinates through lock files on disk. This is reliable on a local file system,
    but locking guarantees on network file systems (NFS, SMB, some cloud volumes) are implementation
    dependent and can be unreliable. For robust horizontal scaling across machines, prefer the Redis locker.

## Summary

* Keep the in-memory locker only for a single-process, single-instance deployment (this is the default).
* For multiple workers on one host with a shared file system, use the file locker.
* For multiple instances across machines, use the Redis locker.
* Also make sure the storage backend itself is shared and consistent; see
  [Backup and restore](backup-restore.md) for how the file backend stores its data.
