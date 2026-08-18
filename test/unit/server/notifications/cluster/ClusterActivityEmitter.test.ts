import { EventEmitter } from 'node:events';
import { DataFactory } from 'n3';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../../../src/http/representation/ResourceIdentifier';
import type { Logger } from '../../../../../src/logging/Logger';
import { getLoggerFor } from '../../../../../src/logging/LogUtil';
import type { ActivityEmitter } from '../../../../../src/server/notifications/ActivityEmitter';
import type {
  ClusterActivityBus,
  SerializedActivity,
} from '../../../../../src/server/notifications/cluster/ClusterActivityBus';
import { ClusterActivityEmitter } from '../../../../../src/server/notifications/cluster/ClusterActivityEmitter';
import { serializeMetadata } from '../../../../../src/server/notifications/cluster/ClusterActivityUtil';
import { InMemoryActivityBus } from '../../../../../src/server/notifications/cluster/InMemoryActivityBus';
import { AS, SOLID_AS } from '../../../../../src/util/Vocabularies';
import { flushPromises } from '../../../../util/Util';

const { namedNode } = DataFactory;

jest.mock('../../../../../src/logging/LogUtil', (): any => {
  const logger: Logger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), log: jest.fn() } as any;
  return { getLoggerFor: (): Logger => logger };
});

describe('A ClusterActivityEmitter', (): void => {
  const logger: jest.Mocked<Logger> = getLoggerFor('mock') as any;
  const topic: ResourceIdentifier = { path: 'http://example.com/foo' };
  let metadata: RepresentationMetadata;
  let source: ActivityEmitter;
  let bus: jest.Mocked<ClusterActivityBus>;

  beforeEach(async(): Promise<void> => {
    jest.clearAllMocks();
    metadata = new RepresentationMetadata(topic, { [SOLID_AS.activity]: AS.terms.Update });
    source = new EventEmitter() as any;
    bus = {
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
    };
  });

  it('publishes serialized source activities on the bus.', async(): Promise<void> => {
    // eslint-disable-next-line no-new
    new ClusterActivityEmitter(source, bus);
    source.emit('changed', topic, AS.terms.Update, metadata);

    await flushPromises();

    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenLastCalledWith({
      topic: topic.path,
      activity: AS.Update,
      metadata: await serializeMetadata(metadata),
    });
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it('emits activities received from the bus.', async(): Promise<void> => {
    const emitter = new ClusterActivityEmitter(source, bus);
    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    const busListener = bus.subscribe.mock.calls[0][0];

    const changedListener = jest.fn();
    const updateListener = jest.fn();
    emitter.on('changed', changedListener);
    emitter.on(AS.Update, updateListener);

    const activity: SerializedActivity = {
      topic: topic.path,
      activity: AS.Update,
      metadata: await serializeMetadata(metadata),
    };
    busListener(activity);

    await flushPromises();

    expect(changedListener).toHaveBeenCalledTimes(1);
    const [ emittedTopic, emittedActivity, emittedMetadata ] = changedListener.mock.calls[0];
    expect(emittedTopic).toEqual(topic);
    expect(emittedActivity).toEqualRdfTerm(AS.terms.Update);
    expect(emittedMetadata.identifier).toEqualRdfTerm(namedNode(topic.path));
    expect(emittedMetadata.quads()).toBeRdfIsomorphic(metadata.quads());

    expect(updateListener).toHaveBeenCalledTimes(1);
    expect(updateListener).toHaveBeenLastCalledWith(emittedTopic, emittedMetadata);
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it('fans out container Add metadata losslessly over an InMemoryActivityBus.', async(): Promise<void> => {
    const container: ResourceIdentifier = { path: 'http://example.com/container/' };
    // The metadata shape of `DataAccessorBasedStore.addContainerActivity`
    const addMetadata = new RepresentationMetadata({
      [SOLID_AS.activity]: AS.terms.Add,
      [AS.object]: namedNode(topic.path),
    });
    const emitter = new ClusterActivityEmitter(source, new InMemoryActivityBus());
    const changedListener = jest.fn();
    emitter.on('changed', changedListener);

    source.emit('changed', container, AS.terms.Add, addMetadata);

    await flushPromises();

    expect(changedListener).toHaveBeenCalledTimes(1);
    const [ emittedTopic, emittedActivity, emittedMetadata ] = changedListener.mock.calls[0];
    expect(emittedTopic).toEqual(container);
    expect(emittedActivity).toEqualRdfTerm(AS.terms.Add);
    expect(emittedMetadata.identifier.termType).toBe('BlankNode');
    expect(emittedMetadata.getAll(AS.terms.object)).toEqualRdfTermArray([ namedNode(topic.path) ]);
    expect(logger.error).toHaveBeenCalledTimes(0);
  });

  it('logs an error when publishing an activity fails.', async(): Promise<void> => {
    bus.publish.mockRejectedValue(new Error('bad bus'));
    // eslint-disable-next-line no-new
    new ClusterActivityEmitter(source, bus);
    source.emit('changed', topic, AS.terms.Update, metadata);

    await flushPromises();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error)
      .toHaveBeenLastCalledWith(`Error publishing activity for ${topic.path}: bad bus`);
  });

  it('logs an error when an invalid activity is received from the bus.', async(): Promise<void> => {
    const emitter = new ClusterActivityEmitter(source, bus);
    const busListener = bus.subscribe.mock.calls[0][0];
    const changedListener = jest.fn();
    emitter.on('changed', changedListener);

    busListener({
      topic: topic.path,
      activity: AS.Update,
      metadata: { identifier: { termType: 'NamedNode', value: topic.path }, quads: 'not valid n-quads' },
    });

    // Two flushes as guarded streams only re-emit their error one `setImmediate` after a listener attaches
    await flushPromises();
    await flushPromises();

    expect(changedListener).toHaveBeenCalledTimes(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining(
      `Error emitting activity for ${topic.path}: `,
    ));
  });
});
