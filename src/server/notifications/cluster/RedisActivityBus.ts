import Redis from 'ioredis';
import type { Finalizable } from '../../../init/final/Finalizable';
import type { Initializable } from '../../../init/Initializable';
import { getLoggerFor } from '../../../logging/LogUtil';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import type { RedisSettings } from '../../../util/locking/RedisLocker';
import type { ClusterActivityBus, SerializedActivity } from './ClusterActivityBus';

/**
 * A {@link ClusterActivityBus} backed by Redis pub/sub, for multi-instance deployments.
 * All instances share a single Redis channel, prefixed with the `namespacePrefix` setting.
 * Redis delivers published messages to every subscribed connection, including those of the publishing process,
 * so activities loop back to the publishing instance as the bus contract requires.
 * A connection in subscriber mode can not issue regular commands, so separate connections publish and subscribe.
 */
export class RedisActivityBus implements ClusterActivityBus, Initializable, Finalizable {
  protected readonly logger = getLoggerFor(this);

  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly channel: string;
  private readonly listeners: ((activity: SerializedActivity) => void)[] = [];
  private finalized = false;

  /**
   * Creates a new RedisActivityBus.
   *
   * @param redisClient - Redis connection string of a standalone Redis node.
   * @param channel - Name of the Redis channel used to exchange activities.
   * @param redisSettings - Additional settings used to create the Redis clients.
   *                        The `namespacePrefix` setting prefixes the channel name.
   */
  public constructor(redisClient = '127.0.0.1:6379', channel = 'css:activity', redisSettings?: RedisSettings) {
    redisSettings = { namespacePrefix: '', ...redisSettings };
    const { namespacePrefix, ...options } = redisSettings;
    this.publisher = this.createRedisClient(redisClient, options);
    this.subscriber = this.createRedisClient(redisClient, options);
    this.channel = `${namespacePrefix}${channel}`;
  }

  /**
   * Generate and return a RedisClient based on the provided string.
   * Identical to the client creation of {@link RedisLocker}.
   *
   * @param redisClientString - A string that contains either a host address and a
   *                            port number like '127.0.0.1:6379' or just a port number like '6379'.
   * @param options - Settings used to create the client.
   */
  private createRedisClient(redisClientString: string, options: Omit<RedisSettings, 'namespacePrefix'>): Redis {
    if (redisClientString.length > 0) {
      // Check if port number or ip with port number
      // Definitely not perfect, but configuring this is only for experienced users
      const match = /^(?:([^:]+):)?(\d{4,5})$/u.exec(redisClientString);
      if (!match?.[2]) {
        // At least a port number should be provided
        throw new Error(`Invalid data provided to create a Redis client: ${redisClientString}\n
            Please provide a port number like '6379' or a host address and a port number like '127.0.0.1:6379'`);
      }
      const port = Number(match[2]);
      const host = match[1];
      return new Redis(port, host, options);
    }
    throw new Error(`Empty redisClientString provided!\n
            Please provide a port number like '6379' or a host address and a port number like '127.0.0.1:6379'`);
  }

  public async publish(activity: SerializedActivity): Promise<void> {
    if (this.finalized) {
      throw new Error('Invalid state: cannot publish activities once finalize() has been called.');
    }
    await this.publisher.publish(this.channel, JSON.stringify(activity));
  }

  public subscribe(listener: (activity: SerializedActivity) => void): void {
    // Listeners can subscribe at any time, but delivery only starts once `initialize` has been called
    this.listeners.push(listener);
  }

  /* Initializer & Finalizer methods */

  public async initialize(): Promise<void> {
    // This connection only ever subscribes to `this.channel`, so incoming messages need no filtering
    this.subscriber.on('message', (channel: string, message: string): void => this.handleMessage(message));
    await this.subscriber.subscribe(this.channel);
  }

  public async finalize(): Promise<void> {
    this.finalized = true;
    try {
      await this.subscriber.quit();
    } finally {
      // Always quit the publishing client as well
      await this.publisher.quit();
    }
  }

  /**
   * Calls all registered listeners with the parsed activity.
   * Errors are logged instead of thrown,
   * as a malformed message on the shared channel should not take down the process.
   */
  private handleMessage(message: string): void {
    try {
      const activity = JSON.parse(message) as SerializedActivity;
      for (const listener of this.listeners) {
        listener(activity);
      }
    } catch (error: unknown) {
      this.logger.error(`Error handling activity message: ${createErrorMessage(error)}`);
    }
  }
}
