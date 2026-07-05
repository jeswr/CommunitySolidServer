import { DataFactory } from 'n3';
import { RepresentationMetadata } from '../../../http/representation/RepresentationMetadata';
import { parseQuads, serializeQuads } from '../../../util/QuadUtil';
import { guardedStreamFrom, readableToString } from '../../../util/StreamUtil';
import type { SerializedMetadata } from './ClusterActivityBus';

/**
 * The content type used for metadata quads on the wire.
 */
const WIRE_CONTENT_TYPE = 'application/n-quads';

/**
 * Serializes a {@link RepresentationMetadata} into a wire-safe {@link SerializedMetadata}.
 *
 * Besides the quads, the identifier term of the metadata is stored explicitly:
 * it can not be derived from the quads or the topic,
 * as some activity metadata, such as that of `Add`/`Remove` activities on containers,
 * uses a blank node as identifier.
 *
 * @param metadata - Metadata to serialize.
 */
export async function serializeMetadata(metadata: RepresentationMetadata): Promise<SerializedMetadata> {
  const { identifier } = metadata;
  const quads = await readableToString(serializeQuads(metadata.quads(), WIRE_CONTENT_TYPE));
  return {
    identifier: { termType: identifier.termType, value: identifier.value },
    quads,
  };
}

/**
 * Deserializes a {@link SerializedMetadata} back into a {@link RepresentationMetadata}.
 *
 * The result is equivalent to the metadata that was serialized:
 * it has the same identifier term and the same quads,
 * so all metadata lookups behave identically on both sides of the wire.
 *
 * @param serialized - Serialized metadata to rebuild.
 */
export async function deserializeMetadata(serialized: SerializedMetadata): Promise<RepresentationMetadata> {
  const { identifier, quads } = serialized;
  const term = identifier.termType === 'NamedNode' ?
      DataFactory.namedNode(identifier.value) :
      DataFactory.blankNode(identifier.value);
  // The empty `blankNodePrefix` prevents the parser from renaming blank nodes,
  // which would break the link between a blank node identifier and its quads.
  const parsed = await parseQuads(guardedStreamFrom(quads), { format: WIRE_CONTENT_TYPE, blankNodePrefix: '' });
  return new RepresentationMetadata(term).addQuads(parsed);
}
