import { ListeningActivityHandler } from '../ListeningActivityHandler';
import type { NotificationChannel } from '../NotificationChannel';
import { isWebhook2023Channel } from './WebhookChannel2023Type';

/**
 * A {@link ListeningActivityHandler} dedicated to WebhookChannel2023 channels.
 *
 * This handler should listen to the emitter of the local `ResourceStore`,
 * so in a multi-instance deployment only the instance where a change originates
 * sends out the corresponding webhooks, preventing duplicate deliveries.
 */
export class WebhookListeningActivityHandler extends ListeningActivityHandler {
  protected supports(channel: NotificationChannel): boolean {
    return isWebhook2023Channel(channel);
  }
}
