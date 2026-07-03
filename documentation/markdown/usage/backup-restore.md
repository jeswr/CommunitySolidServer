# Backup and restore (file backend)

When the server runs with a file-based configuration
(for example `config/file.json`, started with `-f /path/to/data`),
all state is stored below the root file path (`--rootFilePath`/`-f`).
This page describes what lives there, how to take a consistent backup, and how to restore it.

This applies to the file backend. Servers using the in-memory backend (the default `config/default.json`)
keep everything in memory and have nothing on disk to back up.

## What is stored in the root file path

The root file path contains two kinds of data:

* **Pod and resource data.**
  The resources users create are stored as files and directories that mirror their URLs,
  next to their metadata (stored in companion files, by default with a `.meta` suffix).
* **Server-internal state**, under the hidden `.internal/` directory.
  This directory is deliberately hidden from the Solid interface and is *not* exposed over HTTP,
  but it is essential and must be included in any backup. It contains, among others:

    * `.internal/accounts/` – account records, including login/password data and
      `.internal/accounts/credentials/` for [client credentials](client-credentials.md) tokens.
    * `.internal/idp/keys/` – the OpenID Connect signing keys.
    * `.internal/idp/adapter/` – OIDC registration/session state.
    * `.internal/idp/tokens/` – issued OIDC tokens.
    * `.internal/forgot-password/` – pending password-reset records.
    * `.internal/notifications/` – notification channel state.
    * `.internal/setup/` – setup/version markers used by data migrations.
    * `.internal/locks/` – lock files, when the file-based locker is used.

!!! danger "Back up the whole root file path, including `.internal`"
    A backup of only the visible pod data is **not** restorable: without `.internal` you lose all accounts,
    credentials and OIDC keys. Losing `.internal/idp/keys/` in particular invalidates every existing
    token and session, forcing all clients to re-authenticate. Always copy the *entire* root file path.

!!! note "Keep the base URL stable"
    Resource identifiers are derived from the server's base URL (`--baseUrl`/`-b`).
    Restore the data behind the same base URL it was created with; changing the base URL effectively
    rehosts the data at different identifiers.

## Taking a backup

### Cold backup (recommended)

The only way to guarantee a fully consistent snapshot is to make sure nothing is writing during the copy:

1. Stop the server (allow it to shut down cleanly so finalizers run and locks are released).
2. Copy the entire root file path, preserving permissions, symlinks and hidden files, e.g.:

    ```shell
    # server is stopped
    tar czpf css-backup-$(date +%F).tar.gz -C /path/to/data .
    # or
    rsync -a --delete /path/to/data/ /path/to/backup/
    ```

3. Start the server again.

### Online backup caveats

If you cannot stop the server, be aware that a plain live copy of the directory is **not** guaranteed to be
consistent: files (including account and OIDC state under `.internal`) may be copied mid-write,
and a resource and its metadata companion file may be captured at different moments.

* Prefer an **atomic file-system or volume snapshot** (LVM, ZFS, or a cloud block-storage snapshot)
  so the whole tree is captured at a single point in time, then copy from the snapshot.
* If you must use a live `rsync`/`cp`, treat the result as best-effort: run the copy, then run it again to
  narrow the window, and expect that a small number of in-flight resources may be inconsistent.
  This is acceptable for coarse disaster recovery but not for a guaranteed point-in-time restore.
* The server's own resource locks do not make a directory copy consistent: they serialize the server's
  writes but are not visible to an external copy tool, and the in-memory locker keeps no on-disk state at all.
  See [Scaling, clustering and locking](scaling-and-locking.md) for the locker options.

## Restoring a backup

1. Stop the server if it is running. **Never restore into a running server**, as it will be writing to the
   same files.
2. Replace the root file path with the backup contents, preserving permissions and hidden files, e.g.:

    ```shell
    rsync -a --delete /path/to/backup/ /path/to/data/
    ```

3. Remove any stale lock files if a lock directory was captured while the server was running:

    ```shell
    rm -rf /path/to/data/.internal/locks
    ```

    The file locker also clears this directory on a clean start, but removing it avoids confusion after an
    unclean copy.
4. Make sure the restored files are owned by and readable/writable for the user that runs the server.
5. Start the server with the **same** base URL and configuration as the backed-up instance.

Because the restore includes `.internal/idp/keys/`, existing tokens and sessions remain valid after a
restore to the same base URL. If those keys were lost or intentionally rotated, clients will need to
re-authenticate.
