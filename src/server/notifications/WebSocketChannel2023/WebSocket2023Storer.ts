import type { WebSocket } from 'ws';
import type { Finalizable } from '../../../init/final/Finalizable';
import { getLoggerFor } from '../../../logging/LogUtil';
import type { SetMultiMap } from '../../../util/map/SetMultiMap';
import { setSafeInterval } from '../../../util/TimerUtil';
import type { NotificationChannelStorage } from '../NotificationChannelStorage';
import type { WebSocket2023HandlerInput } from './WebSocket2023Handler';
import { WebSocket2023Handler } from './WebSocket2023Handler';

/**
 * Keeps track of the WebSockets that were opened for a WebSocketChannel2023 channel.
 * The WebSockets are stored in the map using the identifier of the matching channel.
 *
 * `cleanupTimer` defines in minutes how often the stored WebSockets are closed
 * if their corresponding channel has expired.
 * Defaults to 60 minutes.
 * Open WebSockets will not receive notifications if their channel expired.
 *
 * `heartbeatInterval` defines in seconds how often the stored WebSockets are pinged
 * to detect and terminate half-open connections that no longer answer with a pong.
 * Defaults to 0, which disables the heartbeat.
 */
export class WebSocket2023Storer extends WebSocket2023Handler implements Finalizable {
  protected readonly logger = getLoggerFor(this);

  private readonly storage: NotificationChannelStorage;
  private readonly socketMap: SetMultiMap<string, WebSocket>;
  private readonly heartbeatInterval: number;
  private readonly aliveSockets: Set<WebSocket>;
  private readonly cleanupTimer: NodeJS.Timeout;
  private readonly heartbeatTimer?: NodeJS.Timeout;

  public constructor(
    storage: NotificationChannelStorage,
    socketMap: SetMultiMap<string, WebSocket>,
    cleanupTimer = 60,
    heartbeatInterval = 0,
  ) {
    super();
    this.socketMap = socketMap;
    this.storage = storage;
    this.heartbeatInterval = heartbeatInterval;
    this.aliveSockets = new Set<WebSocket>();

    this.cleanupTimer = setSafeInterval(
      this.logger,
      'Failed to remove closed WebSockets',
      this.closeExpiredSockets.bind(this),
      cleanupTimer * 60 * 1000,
    );
    this.cleanupTimer.unref();

    if (heartbeatInterval > 0) {
      this.heartbeatTimer = setSafeInterval(
        this.logger,
        'Failed to send WebSocket heartbeat',
        this.sendHeartbeat.bind(this),
        heartbeatInterval * 1000,
      );
      this.heartbeatTimer.unref();
    }
  }

  public async handle({ webSocket, channel }: WebSocket2023HandlerInput): Promise<void> {
    this.socketMap.add(channel.id, webSocket);
    if (this.heartbeatInterval > 0) {
      // A new socket counts as alive until it misses a ping
      this.aliveSockets.add(webSocket);
      webSocket.on('pong', (): void => {
        this.aliveSockets.add(webSocket);
      });
    }
    webSocket.on('error', (): void => this.removeSocket(channel.id, webSocket));
    webSocket.on('close', (): void => this.removeSocket(channel.id, webSocket));
  }

  /**
   * Removes a WebSocket from all tracking structures.
   */
  private removeSocket(id: string, webSocket: WebSocket): void {
    this.aliveSockets.delete(webSocket);
    this.socketMap.deleteEntry(id, webSocket);
  }

  /**
   * Close all WebSockets that are attached to a channel that no longer exists.
   */
  private async closeExpiredSockets(): Promise<void> {
    this.logger.debug('Closing expired WebSockets');
    for (const [ id, sockets ] of this.socketMap.entrySets()) {
      const result = await this.storage.get(id);
      if (!result) {
        for (const socket of sockets) {
          // Due to the attached listener, this also deletes the entries in the `socketMap`
          socket.send(`Notification channel has expired`);
          socket.close();
        }
      }
    }
    this.logger.debug('Finished closing expired WebSockets');
  }

  /**
   * Ping every stored WebSocket and terminate those that did not answer the previous ping with a pong.
   * Terminated sockets get removed from the map by their attached `close` listener.
   */
  private sendHeartbeat(): void {
    this.logger.debug('Sending WebSocket heartbeat pings');
    // Iterate over a snapshot as terminating a socket mutates the map through its `close` listener
    for (const socket of new Set(this.socketMap.values())) {
      if (this.aliveSockets.has(socket)) {
        // Removing the socket marks it as pending until its pong re-adds it
        this.aliveSockets.delete(socket);
        socket.ping();
      } else {
        socket.terminate();
      }
    }
    this.logger.debug('Finished sending WebSocket heartbeat pings');
  }

  public async finalize(): Promise<void> {
    clearInterval(this.cleanupTimer);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
  }
}
