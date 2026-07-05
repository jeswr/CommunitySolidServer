import EventEmitter from 'node:events';
import type { Logger } from '../../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../../src/logging/LogUtil';
import type { SerializedActivity } from '../../../../../src/server/notifications/cluster/ClusterActivityBus';
import { RedisActivityBus } from '../../../../../src/server/notifications/cluster/RedisActivityBus';

/**
 * The mock of an ioredis client, one instance per `new Redis()` call.
 */
type MockRedis = EventEmitter & {
  publish: jest.Mock;
  subscribe: jest.Mock;
  quit: jest.Mock;
  port: number;
  host?: string;
  options: Record<string, unknown>;
};

const mockClients: MockRedis[] = [];

jest.mock('ioredis', (): any => jest.fn().mockImplementation(
  (port: number, host?: string, options?: Record<string, unknown>): MockRedis => {
    const client: MockRedis = Object.assign(new EventEmitter(), {
      publish: jest.fn().mockResolvedValue(1),
      subscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
      port,
      host,
      options: options ?? {},
    });
    mockClients.push(client);
    return client;
  },
));

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { error: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A RedisActivityBus', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  const activity: SerializedActivity = {
    topic: 'http://example.com/foo',
    activity: 'https://www.w3.org/ns/activitystreams#Add',
    metadata: {
      identifier: { termType: 'BlankNode', value: 'b1' },
      quads: '_:b1 <https://www.w3.org/ns/activitystreams#object> <http://example.com/foo/bar> .\n',
    },
  };
  let bus: RedisActivityBus;
  let publisher: MockRedis;
  let subscriber: MockRedis;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    mockClients.length = 0;
    bus = new RedisActivityBus('6379');
    [ publisher, subscriber ] = mockClients;
  });

  it('connects to localhost by default.', async(): Promise<void> => {
    mockClients.length = 0;
    // eslint-disable-next-line no-new
    new RedisActivityBus();
    expect(mockClients).toHaveLength(2);
    for (const client of mockClients) {
      expect(client.port).toBe(6379);
      expect(client.host).toBe('127.0.0.1');
    }
  });

  it('creates a separate publisher and subscriber client.', async(): Promise<void> => {
    expect(mockClients).toHaveLength(2);
    expect(publisher.port).toBe(6379);
    expect(publisher.host).toBeUndefined();
    expect(subscriber.port).toBe(6379);
    expect(subscriber.host).toBeUndefined();
  });

  it('parses the connection string and passes on the Redis settings.', async(): Promise<void> => {
    mockClients.length = 0;
    // eslint-disable-next-line no-new
    new RedisActivityBus('myhost:16379', 'css:activity', { namespacePrefix: 'pre:', username: 'user', db: 4 });
    expect(mockClients).toHaveLength(2);
    for (const client of mockClients) {
      expect(client.port).toBe(16379);
      expect(client.host).toBe('myhost');
      // The `namespacePrefix` setting is not a client option
      expect(client.options).toEqual({ username: 'user', db: 4 });
    }
  });

  it('errors on invalid connection strings.', async(): Promise<void> => {
    expect((): RedisActivityBus => new RedisActivityBus('noport'))
      .toThrow('Invalid data provided to create a Redis client: noport');
    expect((): RedisActivityBus => new RedisActivityBus('123'))
      .toThrow('Invalid data provided to create a Redis client: 123');
    expect((): RedisActivityBus => new RedisActivityBus(''))
      .toThrow('Empty redisClientString provided!');
  });

  it('subscribes to the channel on initialize.', async(): Promise<void> => {
    await expect(bus.initialize()).resolves.toBeUndefined();
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenLastCalledWith('css:activity');
    expect(publisher.subscribe).toHaveBeenCalledTimes(0);
  });

  it('prefixes the channel with the namespacePrefix.', async(): Promise<void> => {
    mockClients.length = 0;
    const prefixedBus = new RedisActivityBus('6379', 'my:channel', { namespacePrefix: 'tenant1:' });
    const [ prefixedPublisher, prefixedSubscriber ] = mockClients;

    await prefixedBus.initialize();
    expect(prefixedSubscriber.subscribe).toHaveBeenLastCalledWith('tenant1:my:channel');

    await prefixedBus.publish(activity);
    expect(prefixedPublisher.publish).toHaveBeenLastCalledWith('tenant1:my:channel', JSON.stringify(activity));
  });

  it('publishes activities as JSON on the channel.', async(): Promise<void> => {
    await expect(bus.publish(activity)).resolves.toBeUndefined();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenLastCalledWith('css:activity', JSON.stringify(activity));
    // The envelope decodes losslessly, keeping the explicit identifier term and the N-Quads intact
    expect(JSON.parse(publisher.publish.mock.calls[0][1])).toEqual(activity);
  });

  it('delivers received messages to all subscribed listeners.', async(): Promise<void> => {
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    bus.subscribe(listener1);
    bus.subscribe(listener2);
    await bus.initialize();

    subscriber.emit('message', 'css:activity', JSON.stringify(activity));

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener1).toHaveBeenLastCalledWith(activity);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenLastCalledWith(activity);
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it('logs an error on malformed messages.', async(): Promise<void> => {
    const listener = jest.fn();
    bus.subscribe(listener);
    await bus.initialize();

    subscriber.emit('message', 'css:activity', 'not json');

    expect(listener).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('Error handling activity message: '));
  });

  it('logs an error when a listener errors.', async(): Promise<void> => {
    bus.subscribe(jest.fn().mockImplementation((): never => {
      throw new Error('bad listener');
    }));
    await bus.initialize();

    subscriber.emit('message', 'css:activity', JSON.stringify(activity));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith('Error handling activity message: bad listener');
  });

  it('quits both clients on finalize.', async(): Promise<void> => {
    await expect(bus.finalize()).resolves.toBeUndefined();
    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    expect(publisher.quit).toHaveBeenCalledTimes(1);
  });

  it('still quits the publisher when the subscriber fails to quit.', async(): Promise<void> => {
    subscriber.quit.mockRejectedValue(new Error('quit failure'));
    await expect(bus.finalize()).rejects.toThrow('quit failure');
    expect(publisher.quit).toHaveBeenCalledTimes(1);
  });

  it('errors when publishing after finalize.', async(): Promise<void> => {
    await bus.finalize();
    await expect(bus.publish(activity)).rejects
      .toThrow('Invalid state: cannot publish activities once finalize() has been called.');
    expect(publisher.publish).toHaveBeenCalledTimes(0);
  });
});
