import AsyncLock from 'async-lock';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { SingleThreaded } from '../../init/cluster/SingleThreaded';
import { getLoggerFor } from '../../logging/LogUtil';
import { InternalServerError } from '../errors/InternalServerError';
import type { ResourceLocker } from './ResourceLocker';

/**
 * A resource locker making use of the `async-lock` library.
 * Note that all locks are kept in memory until they are unlocked which could potentially result
 * in a memory leak if locks are never unlocked, so make sure this is covered with expiring locks for example,
 * and/or proper `finally` handles.
 */
export class MemoryResourceLocker implements ResourceLocker, SingleThreaded {
  protected readonly logger = getLoggerFor(this);

  private readonly locker: AsyncLock;
  private readonly unlockCallbacks: Record<string, () => void>;

  public constructor() {
    this.locker = new AsyncLock();
    this.unlockCallbacks = {};
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
   * The number of resource locks currently held by this locker.
   *
   * This is a pure, side-effect-free read of the in-memory lock bookkeeping: it never acquires or
   * releases a lock and never mutates any state. It is exposed for observability (e.g. saturation
   * metrics) so operators can see how many locks are active at any moment.
   */
  public getLockCount(): number {
    return Object.keys(this.unlockCallbacks).length;
  }
}
