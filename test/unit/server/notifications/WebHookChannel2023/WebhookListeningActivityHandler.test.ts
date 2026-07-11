import { EventEmitter } from 'node:events';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../../../src/http/representation/ResourceIdentifier';
import type { Logger } from '../../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../../src/logging/LogUtil';
import type { ActivityEmitter } from '../../../../../src/server/notifications/ActivityEmitter';
import type { NotificationChannel } from '../../../../../src/server/notifications/NotificationChannel';
import type {
  NotificationChannelStorage,
} from '../../../../../src/server/notifications/NotificationChannelStorage';
import type { NotificationHandler } from '../../../../../src/server/notifications/NotificationHandler';
import {
  WebhookListeningActivityHandler,
} from '../../../../../src/server/notifications/WebhookChannel2023/WebhookListeningActivityHandler';
import { AS, NOTIFY } from '../../../../../src/util/Vocabularies';
import { flushPromises } from '../../../../util/Util';

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { error: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A WebhookListeningActivityHandler', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  const topic: ResourceIdentifier = { path: 'http://example.com/foo' };
  const activity = AS.terms.Update;
  const metadata = new RepresentationMetadata();
  let channel: NotificationChannel;
  let storage: jest.Mocked<NotificationChannelStorage>;
  let emitter: ActivityEmitter;
  let notificationHandler: jest.Mocked<NotificationHandler>;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    channel = {
      id: 'id',
      topic: 'http://example.com/foo',
      type: NOTIFY.WebhookChannel2023,
    };

    storage = {
      getAll: jest.fn().mockResolvedValue([ channel.id ]),
      get: jest.fn().mockResolvedValue(channel),
      update: jest.fn(),
    } as any;

    emitter = new EventEmitter() as any;

    notificationHandler = {
      handleSafe: jest.fn().mockResolvedValue(undefined),
    } as any;

    // eslint-disable-next-line no-new
    new WebhookListeningActivityHandler(storage, emitter, notificationHandler);
  });

  it('calls the NotificationHandler for webhook channels.', async(): Promise<void> => {
    emitter.emit('changed', topic, activity, metadata);

    await flushPromises();

    expect(notificationHandler.handleSafe).toHaveBeenCalledTimes(1);
    expect(notificationHandler.handleSafe).toHaveBeenLastCalledWith({ channel, activity, topic, metadata });
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it('ignores channels of a different type.', async(): Promise<void> => {
    channel.type = NOTIFY.WebSocketChannel2023;
    emitter.emit('changed', topic, activity, metadata);

    await flushPromises();

    expect(notificationHandler.handleSafe).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledTimes(0);
  });
});
