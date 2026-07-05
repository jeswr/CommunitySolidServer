/**
 * Serialized RDF term identifying the subject of the metadata in a {@link SerializedMetadata}.
 *
 * This is not always the topic IRI:
 * `Add`/`Remove` activities on containers, for example,
 * generate metadata whose identifier is a blank node.
 */
export interface SerializedMetadataIdentifier {
  /**
   * The term type of the metadata identifier.
   */
  termType: 'NamedNode' | 'BlankNode';
  /**
   * The value of the metadata identifier: an IRI for named nodes, a label for blank nodes.
   */
  value: string;
}

/**
 * Wire-safe form of a `RepresentationMetadata`.
 */
export interface SerializedMetadata {
  /**
   * The identifier of the metadata.
   */
  identifier: SerializedMetadataIdentifier;
  /**
   * All quads of the metadata, serialized as N-Quads.
   */
  quads: string;
}

/**
 * Wire form of a resource-change activity, safe to cross a process boundary.
 */
export interface SerializedActivity {
  /**
   * The topic resource IRI (`ResourceIdentifier.path`).
   */
  topic: string;
  /**
   * The ActivityStreams activity IRI, e.g., `https://www.w3.org/ns/activitystreams#Update`.
   */
  activity: string;
  /**
   * The metadata describing the change.
   */
  metadata: SerializedMetadata;
  /**
   * Optional identifier of the originating instance, for tracing or idempotency purposes.
   */
  origin?: string;
}

/**
 * A pluggable cross-instance transport for resource-change activities.
 *
 * Implementations are expected to deliver every published activity to all instances of the cluster,
 * including, by contract, the publishing instance itself.
 */
export interface ClusterActivityBus {
  /**
   * Publishes an activity to all instances, including this one.
   *
   * @param activity - The activity to publish.
   */
  publish: (activity: SerializedActivity) => Promise<void>;

  /**
   * Registers a listener that will be invoked once for every activity received from the bus.
   *
   * @param listener - The listener to register.
   */
  subscribe: (listener: (activity: SerializedActivity) => void) => void;
}
