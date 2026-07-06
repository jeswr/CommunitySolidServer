import type { WebSocket } from 'ws';
import type { RepresentationMetadata } from '../../../http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../http/representation/ResourceIdentifier';
import type { AS, VocabularyTerm } from '../../../util/Vocabularies';
import type { SetMultiMap } from '../../../util/map/SetMultiMap';
import type { ActivityEmitter } from '../ActivityEmitter';
import { ListeningActivityHandler } from '../ListeningActivityHandler';
import type { NotificationChannel } from '../NotificationChannel';
import type { NotificationChannelStorage } from '../NotificationChannelStorage';
import type { NotificationHandler } from '../NotificationHandler';
import { isWebSocket2023Channel } from './WebSocketChannel2023Type';

/**
 * A {@link ListeningActivityHandler} dedicated to WebSocketChannel2023 channels.
 *
 * WebSockets are pinned to the instance that accepted them,
 * so in a multi-instance deployment this handler should listen to an emitter
 * that reports the resource changes of the entire cluster, such as a `ClusterActivityEmitter`:
 * every instance can then deliver notifications to the sockets it holds,
 * no matter which instance performed the change.
 *
 * For the same reason, all work can be skipped when this instance holds no matching socket:
 * an instance without the socket of a channel could never deliver its notifications anyway.
 * Events are ignored entirely when there are no local sockets at all,
 * without even querying the channel storage,
 * and individual channels are skipped when their socket lives on a different instance.
 */
export class WebSocketListeningActivityHandler extends ListeningActivityHandler {
  private readonly socketMap: SetMultiMap<string, WebSocket>;

  public constructor(
    storage: NotificationChannelStorage,
    emitter: ActivityEmitter,
    handler: NotificationHandler,
    socketMap: SetMultiMap<string, WebSocket>,
  ) {
    super(storage, emitter, handler);
    this.socketMap = socketMap;
  }

  protected async emit(
    topic: ResourceIdentifier,
    activity: VocabularyTerm<typeof AS>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    // Without local sockets no notification could be delivered, so no work needs to be done
    if (this.socketMap.size === 0) {
      return;
    }
    return super.emit(topic, activity, metadata);
  }

  protected supports(channel: NotificationChannel): boolean {
    // The socket of a channel is stored using the channel identifier by the `WebSocket2023Storer`
    return isWebSocket2023Channel(channel) && this.socketMap.has(channel.id);
  }
}
