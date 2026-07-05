import type { ClusterActivityBus, SerializedActivity } from './ClusterActivityBus';

/**
 * A {@link ClusterActivityBus} for single-process deployments.
 *
 * Publishing synchronously calls every subscribed listener,
 * so activities loop back to the publishing instance
 * with the same semantics as the in-process `ActivityEmitter`.
 */
export class InMemoryActivityBus implements ClusterActivityBus {
  private readonly listeners: ((activity: SerializedActivity) => void)[] = [];

  public async publish(activity: SerializedActivity): Promise<void> {
    for (const listener of this.listeners) {
      listener(activity);
    }
  }

  public subscribe(listener: (activity: SerializedActivity) => void): void {
    this.listeners.push(listener);
  }
}
