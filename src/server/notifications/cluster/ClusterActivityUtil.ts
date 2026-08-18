import { DataFactory } from 'n3';
import { RepresentationMetadata } from '../../../http/representation/RepresentationMetadata';
import { parseQuads, serializeQuads } from '../../../util/QuadUtil';
import { guardedStreamFrom, readableToString } from '../../../util/StreamUtil';
import type { SerializedMetadata } from './ClusterActivityBus';

const WIRE_CONTENT_TYPE = 'application/n-quads';

/**
 * Serializes a {@link RepresentationMetadata} into a wire-safe {@link SerializedMetadata}.
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
 * @param serialized - Serialized metadata to rebuild.
 */
export async function deserializeMetadata(serialized: SerializedMetadata): Promise<RepresentationMetadata> {
  const { identifier, quads } = serialized;
  const term = identifier.termType === 'NamedNode' ?
      DataFactory.namedNode(identifier.value) :
      DataFactory.blankNode(identifier.value);
  // An empty `blankNodePrefix` keeps blank node labels intact so the identifier still matches its quads.
  const parsed = await parseQuads(guardedStreamFrom(quads), { format: WIRE_CONTENT_TYPE, blankNodePrefix: '' });
  return new RepresentationMetadata(term).addQuads(parsed);
}
