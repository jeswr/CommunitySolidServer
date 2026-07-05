import type { SerializedActivity } from '../../../../../src/server/notifications/cluster/ClusterActivityBus';
import { InMemoryActivityBus } from '../../../../../src/server/notifications/cluster/InMemoryActivityBus';

describe('An InMemoryActivityBus', (): void => {
  const activity: SerializedActivity = {
    topic: 'http://example.com/foo',
    activity: 'https://www.w3.org/ns/activitystreams#Update',
    metadata: {
      identifier: { termType: 'NamedNode', value: 'http://example.com/foo' },
      quads: '',
    },
  };
  let bus: InMemoryActivityBus;

  beforeEach(async(): Promise<void> => {
    bus = new InMemoryActivityBus();
  });

  it('does nothing when publishing without subscribers.', async(): Promise<void> => {
    await expect(bus.publish(activity)).resolves.toBeUndefined();
  });

  it('calls every subscribed listener once per published activity.', async(): Promise<void> => {
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    bus.subscribe(listener1);
    bus.subscribe(listener2);

    await expect(bus.publish(activity)).resolves.toBeUndefined();
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener1).toHaveBeenLastCalledWith(activity);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenLastCalledWith(activity);

    await expect(bus.publish(activity)).resolves.toBeUndefined();
    expect(listener1).toHaveBeenCalledTimes(2);
    expect(listener2).toHaveBeenCalledTimes(2);
  });
});
