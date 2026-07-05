import Redis from 'ioredis';
import type { Finalizable } from '../../../init/final/Finalizable';
import type { Initializable } from '../../../init/Initializable';
import { getLoggerFor } from '../../../logging/LogUtil';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import type { RedisSettings } from '../../../util/locking/RedisLocker';
import type { ClusterActivityBus, SerializedActivity } from './ClusterActivityBus';

/**
 * A {@link ClusterActivityBus} backed by Redis pub/sub, for multi-instance deployments.
 *
 * Activities cross the wire as the JSON encoding of a {@link SerializedActivity}.
 * That envelope is transported byte-for-byte and is never re-encoded,
 * which keeps the two invariants of the wire format intact:
 * the metadata identifier term stays explicitly available
 * (it can be a blank node, so it can not be derived from the topic),
 * and the metadata quads stay in their exact N-Quads form,
 * whose blank node labels the deserializer relies on.
 *
 * All instances publish on, and subscribe to, a single Redis channel.
 * The channel name defaults to `css:activity` and is prefixed with the `namespacePrefix` setting,
 * scoping it the same way {@link RedisLocker} scopes its keys on a shared Redis server.
 *
 * Because Redis delivers published messages to every subscribed connection,
 * including other connections of the publishing process,
 * activities loop back to the publishing instance as the bus contract requires.
 * A Redis connection in subscriber mode can not issue regular commands,
 * so this class uses two connections: one to publish and one to subscribe.
 * Both are created on construction, mirroring {@link RedisLocker};
 * the subscription starts on `initialize` and both connections close on `finalize`.
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
    // The `message` event only fires for channels this connection is subscribed to,
    // which is only ever `this.channel`, so no further filtering is needed.
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
