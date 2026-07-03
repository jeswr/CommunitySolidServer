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
 * `heartbeatInterval` defines in seconds how often a WebSocket ping/pong heartbeat is sent
 * to every tracked WebSocket to detect and reap half-open (dead) connections.
 * A client killed by a NAT/idle timeout, a laptop going to sleep, or a network drop never sends a
 * `close` frame, so without a heartbeat such a socket would linger in the map forever.
 * The heartbeat pings every tracked socket; a socket that has not answered with a `pong`
 * since the previous cycle is assumed dead and gets `terminate()`d
 * (which also removes it from the map through the attached `close` listener).
 * Ping/pong are RFC 6455 control frames handled automatically by conformant WebSocket clients,
 * so a healthy client is never affected: it auto-pongs and is kept.
 * Defaults to `0`, which **disables** the heartbeat entirely, preserving the previous behaviour.
 * A value such as `30` (seconds) is recommended to enable dead-connection reaping.
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

    // A `heartbeatInterval` of `0` (the default) disables the heartbeat, keeping the previous behaviour.
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
      // A newly opened socket starts out alive; conformant clients answer every ping with a `pong`.
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
   * Ping every tracked WebSocket and reap the ones that did not answer the previous ping with a `pong`.
   * A missed pong indicates a half-open (dead) connection, so it is `terminate()`d;
   * the attached `close` listener then removes it from the `socketMap`.
   */
  private sendHeartbeat(): void {
    this.logger.debug('Sending WebSocket heartbeat pings');
    // Snapshot the sockets first: `terminate()` schedules a `close` event that mutates the `socketMap`.
    for (const socket of new Set(this.socketMap.values())) {
      if (this.aliveSockets.has(socket)) {
        // Answered the previous ping (or was just opened): mark it pending again and ping.
        this.aliveSockets.delete(socket);
        socket.ping();
      } else {
        // No pong since the previous cycle: assume the connection is dead and reap it.
        socket.terminate();
      }
    }
    this.logger.debug('Finished sending WebSocket heartbeat pings');
  }

  /**
   * Stops the cleanup and heartbeat timers so they no longer keep the event loop alive
   * or fire during/after a graceful shutdown.
   */
  public async finalize(): Promise<void> {
    clearInterval(this.cleanupTimer);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
  }
}
