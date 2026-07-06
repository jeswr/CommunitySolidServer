import { ListeningActivityHandler } from '../ListeningActivityHandler';
import type { NotificationChannel } from '../NotificationChannel';
import { isWebhook2023Channel } from './WebhookChannel2023Type';

/**
 * A {@link ListeningActivityHandler} dedicated to WebhookChannel2023 channels.
 *
 * Webhooks are not pinned to an instance:
 * any instance can read the channel from the shared storage and perform the outgoing HTTP request.
 * To prevent duplicate deliveries in a multi-instance deployment,
 * this handler should keep listening to the emitter of the local `ResourceStore`,
 * so only the instance where a change originates sends out the corresponding webhooks.
 *
 * If that instance stops before delivery finishes those notifications are lost,
 * which is identical to the failure behavior of a single-instance deployment.
 */
export class WebhookListeningActivityHandler extends ListeningActivityHandler {
  protected supports(channel: NotificationChannel): boolean {
    return isWebhook2023Channel(channel);
  }
}
