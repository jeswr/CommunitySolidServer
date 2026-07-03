import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import type { Finalizable } from '../../init/final/Finalizable';
import { getLoggerFor } from '../../logging/LogUtil';
import type { KeyValueStorage } from '../../storage/keyvalue/KeyValueStorage';
import { InternalServerError } from '../../util/errors/InternalServerError';
import type { ReadWriteLocker } from '../../util/locking/ReadWriteLocker';
import { setSafeInterval } from '../../util/TimerUtil';
import type { NotificationChannel } from './NotificationChannel';
import type { NotificationChannelStorage } from './NotificationChannelStorage';

type StorageValue = string | string[] | NotificationChannel;

/**
 * Stores all the {@link NotificationChannel} in a {@link KeyValueStorage}.
 * Encodes IDs/topics before storing them in the KeyValueStorage.
 *
 * Uses a {@link ReadWriteLocker} to prevent internal race conditions.
 *
 * Expired channels are already removed lazily the next time they are requested through `get`,
 * but a channel whose topic goes quiet is never requested again and would leak forever.
 * To reclaim those, a periodic background sweep enumerates the storage and removes every channel
 * whose `endAt` is already in the past. Because it reuses the exact same lazy-expiry check as `get`,
 * it can only ever delete channels that are already expired (and thus already invisible to clients);
 * a live channel is never removed. Set `sweepInterval` to `0` to disable the sweep, which restores
 * the lazy-only behaviour.
 *
 * A random fraction of jitter is added to the sweep interval so that, if multiple instances exist,
 * their (potentially expensive) sweeps do not all fire at the same instant.
 *
 * The timer is cleared when the storage is finalized, so it does not keep the event loop alive
 * or prevent a graceful shutdown.
 */
export class KeyValueChannelStorage implements NotificationChannelStorage, Finalizable {
  protected logger = getLoggerFor(this);

  private readonly storage: KeyValueStorage<string, StorageValue>;
  private readonly locker: ReadWriteLocker;
  private readonly timer?: NodeJS.Timeout;

  /**
   * @param storage - Where to store the channels.
   * @param locker - Used to prevent internal race conditions.
   * @param sweepInterval - How often expired channels are swept from the storage, in minutes.
   *                        Defaults to 60. A value of `0` disables the background sweep.
   * @param jitter - Maximum fraction of `sweepInterval` that is randomly added to the interval so that
   *                 multiple instances do not all sweep at the same time. `0` disables jitter.
   */
  public constructor(
    storage: KeyValueStorage<string, StorageValue>,
    locker: ReadWriteLocker,
    sweepInterval = 60,
    jitter = 0.15,
  ) {
    this.storage = storage;
    this.locker = locker;

    if (sweepInterval > 0) {
      const period = sweepInterval * 60 * 1000;
      const jitterMs = Math.floor(Math.random() * period * jitter);
      this.timer = setSafeInterval(
        this.logger,
        'Failed to sweep expired notification channels',
        this.sweepExpiredChannels.bind(this),
        period + jitterMs,
      );
      this.timer.unref();
    }
  }

  public async get(id: string): Promise<NotificationChannel | undefined> {
    const channel = await this.storage.get(encodeURIComponent(id));
    if (channel && this.isChannel(channel)) {
      if (typeof channel.endAt === 'number' && channel.endAt < Date.now()) {
        this.logger.info(`Notification channel ${id} has expired.`);
        await this.locker.withWriteLock(this.getLockKey(id), async(): Promise<void> => {
          await this.deleteChannel(channel);
        });
        return;
      }

      return channel;
    }
  }

  public async getAll(topic: ResourceIdentifier): Promise<string[]> {
    const channels = await this.storage.get(encodeURIComponent(topic.path));
    if (Array.isArray(channels)) {
      return channels;
    }
    return [];
  }

  public async add(channel: NotificationChannel): Promise<void> {
    const target = { path: channel.topic };
    return this.locker.withWriteLock(this.getLockKey(target), async(): Promise<void> => {
      const channels = await this.getAll(target);
      await this.storage.set(encodeURIComponent(channel.id), channel);
      channels.push(channel.id);
      await this.storage.set(encodeURIComponent(channel.topic), channels);
    });
  }

  public async update(channel: NotificationChannel): Promise<void> {
    return this.locker.withWriteLock(this.getLockKey(channel.id), async(): Promise<void> => {
      const oldChannel = await this.storage.get(encodeURIComponent(channel.id));

      if (oldChannel) {
        if (!this.isChannel(oldChannel)) {
          throw new InternalServerError(`Trying to update ${channel.id} which is not a NotificationChannel.`);
        }
        if (channel.topic !== oldChannel.topic) {
          throw new InternalServerError(`Trying to change the topic of a notification channel ${channel.id}`);
        }
      }

      await this.storage.set(encodeURIComponent(channel.id), channel);
    });
  }

  public async delete(id: string): Promise<boolean> {
    return this.locker.withWriteLock(this.getLockKey(id), async(): Promise<boolean> => {
      const channel = await this.get(id);
      if (!channel) {
        return false;
      }
      await this.deleteChannel(channel);
      return true;
    });
  }

  /**
   * Utility function for deleting a specific {@link NotificationChannel} object.
   * Does not create a lock on the channel ID so should be wrapped in such a lock.
   */
  private async deleteChannel(channel: NotificationChannel): Promise<void> {
    await this.locker.withWriteLock(this.getLockKey(channel.topic), async(): Promise<void> => {
      const channels = await this.getAll({ path: channel.topic });
      const idx = channels.indexOf(channel.id);
      // If idx < 0 we have an inconsistency
      if (idx < 0) {
        this.logger.error(`Channel ${channel.id} was not found in the list of channels targeting ${channel.topic}.`);
        this.logger.error('This should not happen and indicates a data consistency issue.');
      } else {
        channels.splice(idx, 1);
        if (channels.length > 0) {
          await this.storage.set(encodeURIComponent(channel.topic), channels);
        } else {
          await this.storage.delete(encodeURIComponent(channel.topic));
        }
      }
      await this.storage.delete(encodeURIComponent(channel.id));
    });
  }

  /**
   * Enumerates the storage and removes every channel whose `endAt` is already in the past.
   *
   * Expired channels are collected first and only deleted afterwards, so the storage is never mutated
   * while its `entries()` iterator is still open. Deletion is delegated to {@link KeyValueChannelStorage#get},
   * which re-checks the expiry under a write lock and repairs the topic index; a channel that is no longer
   * expired (or was already removed concurrently) is therefore never deleted here.
   */
  private async sweepExpiredChannels(): Promise<void> {
    this.logger.debug('Sweeping expired notification channels.');
    const expired: string[] = [];
    for await (const [ , value ] of this.storage.entries()) {
      if (this.isChannel(value) && typeof value.endAt === 'number' && value.endAt < Date.now()) {
        expired.push(value.id);
      }
    }
    for (const id of expired) {
      // `get` deletes the channel (and repairs the topic index) only if it is still expired.
      await this.get(id);
    }
    this.logger.debug(`Finished sweeping expired notification channels, removed ${expired.length}.`);
  }

  private isChannel(value: StorageValue): value is NotificationChannel {
    return Boolean((value as NotificationChannel).id);
  }

  private getLockKey(identifier: ResourceIdentifier | string): ResourceIdentifier {
    return { path: `${typeof identifier === 'string' ? identifier : identifier.path}.notification-storage` };
  }

  /**
   * Stops the background sweep timer so it no longer keeps the event loop alive.
   */
  public async finalize(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
