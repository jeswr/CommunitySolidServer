import AsyncLock from 'async-lock';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { ClusterManager } from '../../init/cluster/ClusterManager';
import type { SingleThreaded } from '../../init/cluster/SingleThreaded';
import { getLoggerFor } from '../../logging/LogUtil';
import { InternalServerError } from '../errors/InternalServerError';
import type { ResourceLocker } from './ResourceLocker';

/**
 * A resource locker making use of the `async-lock` library.
 * Note that all locks are kept in memory until they are unlocked which could potentially result
 * in a memory leak if locks are never unlocked, so make sure this is covered with expiring locks for example,
 * and/or proper `finally` handles.
 *
 * As the name indicates, all locks are only kept in the memory of a single process.
 * They are therefore not shared across workers or server instances,
 * so this locker is only safe to use in a single-process, single-instance deployment.
 * Use a shared locker (such as the Redis locker) when running with multiple workers,
 * in clustered mode, or with multiple server instances on shared storage.
 */
export class MemoryResourceLocker implements ResourceLocker, SingleThreaded {
  protected readonly logger = getLoggerFor(this);

  private readonly locker: AsyncLock;
  private readonly unlockCallbacks: Record<string, () => void>;

  /**
   * @param clusterManager - When provided, a warning is logged if the server is not running in
   *                         singlethreaded mode, since in-memory locks are not shared across workers.
   */
  public constructor(clusterManager?: ClusterManager) {
    this.locker = new AsyncLock();
    this.unlockCallbacks = {};
    if (clusterManager && !clusterManager.isSingleThreaded()) {
      this.logger.warn(
        'Using the in-memory MemoryResourceLocker while running with multiple workers or in clustered mode. ' +
        'Locks are only stored in the memory of a single process, so they are not shared across workers or ' +
        'server instances, and concurrent writes to the same resource can corrupt data. ' +
        'Switch to a shared locker such as the Redis locker (config/util/resource-locker/redis.json) ' +
        'for multi-worker or multi-instance deployments.',
      );
    }
  }

  public async acquire(identifier: ResourceIdentifier): Promise<void> {
    const { path } = identifier;
    this.logger.debug(`Acquiring lock for ${path}`);
    return new Promise((resolve): void => {
      this.locker.acquire(path, (done): void => {
        this.unlockCallbacks[path] = done;
        this.logger.debug(`Acquired lock for ${path}. ${this.getLockCount()} locks active.`);
        resolve();
      }, (): void => {
        delete this.unlockCallbacks[path];
        this.logger.debug(`Released lock for ${path}. ${this.getLockCount()} active locks remaining.`);
      });
    });
  }

  public async release(identifier: ResourceIdentifier): Promise<void> {
    const { path } = identifier;
    if (!this.unlockCallbacks[path]) {
      throw new InternalServerError(`Trying to unlock resource that is not locked: ${path}`);
    }
    this.unlockCallbacks[path]();
  }

  /**
   * Counts the number of active locks.
   */
  private getLockCount(): number {
    return Object.keys(this.unlockCallbacks).length;
  }
}
