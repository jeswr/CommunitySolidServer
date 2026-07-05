import { DataFactory } from 'n3';
import type { RepresentationMetadata } from '../../../http/representation/RepresentationMetadata';
import type { ResourceIdentifier } from '../../../http/representation/ResourceIdentifier';
import { getLoggerFor } from '../../../logging/LogUtil';
import { createErrorMessage } from '../../../util/errors/ErrorUtil';
import type { AS, VocabularyTerm, VocabularyValue } from '../../../util/Vocabularies';
import type { ActivityEmitter } from '../ActivityEmitter';
import { BaseActivityEmitter } from '../ActivityEmitter';
import type { ClusterActivityBus, SerializedActivity } from './ClusterActivityBus';
import { deserializeMetadata, serializeMetadata } from './ClusterActivityUtil';

/**
 * An {@link ActivityEmitter} that emits the activities of all instances in a cluster.
 *
 * Events of the given source emitter are published on the given {@link ClusterActivityBus}.
 * Every activity received from the bus, including those published by this instance,
 * is emitted again by this class,
 * so listeners observe the resource changes of the entire cluster.
 */
export class ClusterActivityEmitter extends BaseActivityEmitter {
  protected readonly logger = getLoggerFor(this);

  private readonly bus: ClusterActivityBus;

  public constructor(source: ActivityEmitter, bus: ClusterActivityBus) {
    super();
    this.bus = bus;

    source.on('changed', (topic, activity, metadata): void => {
      this.publish(topic, activity, metadata).catch((error: unknown): void => {
        this.logger.error(`Error publishing activity for ${topic.path}: ${createErrorMessage(error)}`);
      });
    });

    bus.subscribe((activity): void => {
      this.emitActivity(activity).catch((error: unknown): void => {
        this.logger.error(`Error emitting activity for ${activity.topic}: ${createErrorMessage(error)}`);
      });
    });
  }

  /**
   * Publishes a local activity on the bus.
   */
  private async publish(
    topic: ResourceIdentifier,
    activity: VocabularyTerm<typeof AS>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const serialized = await serializeMetadata(metadata);
    await this.bus.publish({ topic: topic.path, activity: activity.value, metadata: serialized });
  }

  /**
   * Emits an activity received from the bus,
   * mirroring the events emitted by the source emitter.
   */
  private async emitActivity(activity: SerializedActivity): Promise<void> {
    const metadata = await deserializeMetadata(activity.metadata);
    const topic: ResourceIdentifier = { path: activity.topic };
    const term = DataFactory.namedNode(activity.activity) as VocabularyTerm<typeof AS>;
    this.emit('changed', topic, term, metadata);
    this.emit(activity.activity as VocabularyValue<typeof AS>, topic, metadata);
  }
}
