import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { NotificationChannel } from '../../../../../src/server/notifications/NotificationChannel';
import type {
  NotificationChannelStorage,
} from '../../../../../src/server/notifications/NotificationChannelStorage';

import {
  WebSocket2023Storer,
} from '../../../../../src/server/notifications/WebSocketChannel2023/WebSocket2023Storer';
import type { SetMultiMap } from '../../../../../src/util/map/SetMultiMap';
import { WrappedSetMultiMap } from '../../../../../src/util/map/WrappedSetMultiMap';
import { flushPromises } from '../../../../util/Util';

/* eslint-disable jest/prefer-spy-on */
describe('A WebSocket2023Storer', (): void => {
  const channel: NotificationChannel = {
    id: 'id',
    topic: 'http://example.com/foo',
    type: 'type',
  };
  let webSocket: jest.Mocked<WebSocket>;
  let storage: jest.Mocked<NotificationChannelStorage>;
  let socketMap: SetMultiMap<string, WebSocket>;
  let storer: WebSocket2023Storer;

  function createWebSocket(): jest.Mocked<WebSocket> {
    const socket = new EventEmitter() as any;
    socket.send = jest.fn();
    socket.close = jest.fn();
    socket.ping = jest.fn();
    socket.terminate = jest.fn();
    return socket;
  }

  beforeEach(async(): Promise<void> => {
    webSocket = createWebSocket();

    storage = {
      get: jest.fn(),
    } as any;

    socketMap = new WrappedSetMultiMap();

    storer = new WebSocket2023Storer(storage, socketMap);
  });

  it('stores WebSockets.', async(): Promise<void> => {
    await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();
    expect([ ...socketMap.keys() ]).toHaveLength(1);
    expect(socketMap.has(channel.id)).toBe(true);
  });

  it('removes closed WebSockets.', async(): Promise<void> => {
    await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();
    expect(socketMap.has(channel.id)).toBe(true);
    webSocket.emit('close');
    expect(socketMap.has(channel.id)).toBe(false);
  });

  it('removes erroring WebSockets.', async(): Promise<void> => {
    await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();
    expect(socketMap.has(channel.id)).toBe(true);
    webSocket.emit('error');
    expect(socketMap.has(channel.id)).toBe(false);
  });

  it('removes expired WebSockets.', async(): Promise<void> => {
    jest.useFakeTimers();

    // Need to create class after fake timers have been enabled
    storer = new WebSocket2023Storer(storage, socketMap);

    const webSocket2: jest.Mocked<WebSocket> = createWebSocket();
    const webSocketOther: jest.Mocked<WebSocket> = createWebSocket();
    const channelOther: NotificationChannel = {
      ...channel,
      id: 'other',
    };
    await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();
    await expect(storer.handle({ channel, webSocket: webSocket2 })).resolves.toBeUndefined();
    await expect(storer.handle({ channel: channelOther, webSocket: webSocketOther })).resolves.toBeUndefined();

    // `channel` expired, `channelOther` did not
    storage.get.mockImplementation((id): any => {
      if (id === channelOther.id) {
        return channelOther;
      }
    });

    jest.advanceTimersToNextTimer();

    await flushPromises();

    expect(webSocket.close).toHaveBeenCalledTimes(1);
    expect(webSocket2.close).toHaveBeenCalledTimes(1);
    expect(webSocketOther.close).toHaveBeenCalledTimes(0);

    jest.useRealTimers();
  });

  describe('with the heartbeat disabled (the default)', (): void => {
    it('never pings or terminates tracked sockets.', async(): Promise<void> => {
      jest.useFakeTimers();
      storer = new WebSocket2023Storer(storage, socketMap);

      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();

      jest.advanceTimersByTime(60 * 60 * 1000);
      await flushPromises();

      expect(webSocket.ping).toHaveBeenCalledTimes(0);
      expect(webSocket.terminate).toHaveBeenCalledTimes(0);

      jest.useRealTimers();
    });

    it('does not attach a pong listener.', async(): Promise<void> => {
      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();
      expect(webSocket.listenerCount('pong')).toBe(0);
    });

    it('can be finalized without a heartbeat timer.', async(): Promise<void> => {
      await expect(storer.finalize()).resolves.toBeUndefined();
    });
  });

  describe('with the heartbeat enabled', (): void => {
    beforeEach((): void => {
      jest.useFakeTimers();
      storer = new WebSocket2023Storer(storage, socketMap, 60, 30);
    });

    afterEach((): void => {
      jest.useRealTimers();
    });

    it('pings every tracked socket.', async(): Promise<void> => {
      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();

      jest.advanceTimersByTime(30 * 1000);
      await flushPromises();

      expect(webSocket.ping).toHaveBeenCalledTimes(1);
      expect(webSocket.terminate).toHaveBeenCalledTimes(0);
    });

    it('keeps sockets that answer with a pong.', async(): Promise<void> => {
      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();

      jest.advanceTimersByTime(30 * 1000);
      await flushPromises();
      expect(webSocket.ping).toHaveBeenCalledTimes(1);

      webSocket.emit('pong');

      jest.advanceTimersByTime(30 * 1000);
      await flushPromises();
      expect(webSocket.ping).toHaveBeenCalledTimes(2);
      expect(webSocket.terminate).toHaveBeenCalledTimes(0);
    });

    it('terminates sockets that miss a pong.', async(): Promise<void> => {
      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();

      jest.advanceTimersByTime(30 * 1000);
      await flushPromises();
      expect(webSocket.ping).toHaveBeenCalledTimes(1);
      expect(webSocket.terminate).toHaveBeenCalledTimes(0);

      jest.advanceTimersByTime(30 * 1000);
      await flushPromises();
      expect(webSocket.ping).toHaveBeenCalledTimes(1);
      expect(webSocket.terminate).toHaveBeenCalledTimes(1);

      // The mocked `terminate` does not emit the `close` event a real socket would
      webSocket.emit('close');
      expect(socketMap.has(channel.id)).toBe(false);
    });

    it('stops pinging once a socket has closed.', async(): Promise<void> => {
      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();
      webSocket.emit('close');
      expect(socketMap.has(channel.id)).toBe(false);

      jest.advanceTimersByTime(30 * 1000);
      await flushPromises();

      expect(webSocket.ping).toHaveBeenCalledTimes(0);
      expect(webSocket.terminate).toHaveBeenCalledTimes(0);
    });

    it('clears the heartbeat timer when finalized.', async(): Promise<void> => {
      await expect(storer.handle({ channel, webSocket })).resolves.toBeUndefined();

      await expect(storer.finalize()).resolves.toBeUndefined();

      // Neither the heartbeat nor the cleanup timer fires after finalization
      jest.advanceTimersByTime(60 * 60 * 1000);
      await flushPromises();

      expect(webSocket.ping).toHaveBeenCalledTimes(0);
      expect(webSocket.terminate).toHaveBeenCalledTimes(0);
      expect(storage.get).toHaveBeenCalledTimes(0);
    });
  });
});
