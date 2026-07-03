import type { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../logging/LogUtil';
import { createErrorMessage } from '../../util/errors/ErrorUtil';
import { StaticHandler } from '../../util/handlers/StaticHandler';
import type { AS, VocabularyTerm } from '../../util/Vocabularies';
import type { PrometheusMetrics } from '../metrics/PrometheusMetrics';
import type { ActivityEmitter } from './ActivityEmitter';
import type { NotificationChannelStorage } from './NotificationChannelStorage';
import type { NotificationHandler } from './NotificationHandler';

/**
 * Listens to an {@link ActivityEmitter} and calls the stored {@link NotificationHandler}s in case of an event
 * for every matching notification channel found.
 *
 * Takes the `rate` feature into account so only channels that want a new notification will receive one.
 *
 * Extends {@link StaticHandler} so it can be more easily injected into a Components.js configuration.
 * No class takes this one as input, so to make sure Components.js instantiates it,
 * it needs to be added somewhere where its presence has no impact, such as the list of initializers.
 *
 * When a {@link PrometheusMetrics} instance is provided, every delivery attempt increments its
 * `css_notification_deliveries_total` counter with the channel `type` and the delivery `outcome`.
 */
export class ListeningActivityHandler extends StaticHandler {
  protected readonly logger = getLoggerFor(this);

  private readonly storage: NotificationChannelStorage;
  private readonly handler: NotificationHandler;
  private readonly metrics?: PrometheusMetrics;

  /**
   * @param storage - Storage containing the notification channels.
   * @param emitter - Emitter of the activities the channels are listening to.
   * @param handler - Handler to call for every matching notification channel.
   * @param metrics - Optional {@link PrometheusMetrics} used to record delivery outcomes. Default is none.
   */
  public constructor(
    storage: NotificationChannelStorage,
    emitter: ActivityEmitter,
    handler: NotificationHandler,
    metrics?: PrometheusMetrics,
  ) {
    super();
    this.storage = storage;
    this.handler = handler;
    this.metrics = metrics;

    emitter.on('changed', (topic, activity, metadata): void => {
      this.emit(topic, activity, metadata).catch((error: unknown): void => {
        this.logger.error(`Something went wrong emitting notifications: ${createErrorMessage(error)}`);
      });
    });
  }

  private async emit(
    topic: ResourceIdentifier,
    activity: VocabularyTerm<typeof AS>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const channelIds = await this.storage.getAll(topic);

    for (const id of channelIds) {
      const channel = await this.storage.get(id);
      if (!channel) {
        // Notification channel has expired
        continue;
      }

      // Don't emit if the previous notification was too recent according to the requested rate
      if (channel.lastEmit && channel.rate && channel.rate > Date.now() - channel.lastEmit) {
        continue;
      }

      // Don't emit if we have not yet reached the requested starting time
      if (channel.startAt && channel.startAt > Date.now()) {
        continue;
      }

      // No need to wait on this to resolve before going to the next channel.
      // Prevent failed notification from blocking other notifications.
      this.handler.handleSafe({ channel, activity, topic, metadata })
        .then(async(): Promise<void> => {
          this.metrics?.notificationDeliveriesTotal.inc({ type: channel.type, outcome: 'success' });
          // Update the `lastEmit` value if the channel has a rate limit
          if (channel.rate) {
            channel.lastEmit = Date.now();
            return this.storage.update(channel);
          }
        })
        .catch((error: unknown): void => {
          this.metrics?.notificationDeliveriesTotal.inc({ type: channel.type, outcome: 'failure' });
          // Demoted from `error` to `debug`: the aggregate failure rate is now captured by the metric above,
          // and the per-channel identifier is unaggregable noise at info level.
          this.logger.debug(`Error trying to handle notification for ${id}: ${createErrorMessage(error)}`);
        });
    }
  }
}
