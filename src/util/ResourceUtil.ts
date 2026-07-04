import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'n3';
import { BasicRepresentation } from '../http/representation/BasicRepresentation';
import type { Representation } from '../http/representation/Representation';
import { RepresentationMetadata } from '../http/representation/RepresentationMetadata';
import type { Conditions } from '../storage/conditions/Conditions';
import type { ETagHandler } from '../storage/conditions/ETagHandler';
import { NotModifiedHttpError } from './errors/NotModifiedHttpError';
import { guardedStreamFrom } from './StreamUtil';
import { toLiteral } from './TermUtil';
import { CONTENT_TYPE_TERM, DC, HH, LDP, RDF, SOLID_META, XSD } from './Vocabularies';
import namedNode = DataFactory.namedNode;

/**
 * Helper function to generate type quads for a Container or Resource.
 *
 * @param metadata - Metadata to add to.
 * @param isContainer - If the identifier corresponds to a container.
 */
export function addResourceMetadata(metadata: RepresentationMetadata, isContainer: boolean): void {
  if (isContainer) {
    metadata.add(RDF.terms.type, LDP.terms.Container);
    metadata.add(RDF.terms.type, LDP.terms.BasicContainer);
  }
  metadata.add(RDF.terms.type, LDP.terms.Resource);
}

/**
 * Updates the dc:modified time to the given time.
 *
 * @param metadata - Metadata to update.
 * @param date - Last modified date. Defaults to current time.
 */
export function updateModifiedDate(metadata: RepresentationMetadata, date = new Date()): void {
  const lastModified = new Date(date);
  metadata.set(DC.terms.modified, toLiteral(lastModified.toISOString(), XSD.terms.dateTime));
}

/**
 * Links a template file with a given content-type to the metadata using the SOLID_META.template predicate.
 *
 * @param metadata - Metadata to update.
 * @param templateFile - Path to the template.
 * @param contentType - Content-type of the template after it is rendered.
 */
export function addTemplateMetadata(metadata: RepresentationMetadata, templateFile: string, contentType: string):
void {
  const templateNode = namedNode(templateFile);
  metadata.add(SOLID_META.terms.template, templateNode);
  metadata.addQuad(templateNode, CONTENT_TYPE_TERM, contentType);
}

/**
 * Helper function to clone a representation, the original representation can still be used.
 * This function loads the entire stream in memory.
 *
 * @param representation - The representation to clone.
 *
 * @returns The cloned representation.
 */
export async function cloneRepresentation(representation: Representation): Promise<BasicRepresentation> {
  const data = await arrayifyStream(representation.data);
  const result = new BasicRepresentation(
    data,
    new RepresentationMetadata(representation.metadata),
    representation.binary,
  );
  representation.data = guardedStreamFrom(data);
  return result;
}

/**
 * Determines whether the given conditions and metadata result in a "304 Not Modified" response,
 * without reading or modifying any data.
 *
 * If the conditions are defined and do not match the metadata, a {@link NotModifiedHttpError} is
 * returned carrying the resource ETag and a copy of the metadata, so that the 304 response sends
 * exactly the same headers as a full response would. In every other case `undefined` is returned,
 * meaning a normal response should be sent.
 *
 * This uses the strict conditions check which takes the content type into account;
 * therefore, this should only be called once the output content type is certain:
 * either after content negotiation, or when it is known that no conversion will happen.
 *
 * Unlike {@link assertReadConditions}, this function does not touch any data stream and does not modify
 * the given metadata, so it is safe to call before the data of a representation has been fetched.
 *
 * @param metadata - The metadata to compare the conditions against.
 * @param eTagHandler - Used to generate the ETag to return with the 304 response.
 * @param conditions - The conditions to assert.
 *
 * @returns A {@link NotModifiedHttpError} to return if the request resolves to a 304, `undefined` otherwise.
 */
export function getConditionalNotModifiedError(
  metadata: RepresentationMetadata,
  eTagHandler: ETagHandler,
  conditions?: Conditions,
): NotModifiedHttpError | undefined {
  if (conditions && !conditions.matchesMetadata(metadata, true)) {
    const error = new NotModifiedHttpError(eTagHandler.getETag(metadata));

    // From RFC 9111:
    // > the cache MUST add each header field in the provided response to the stored response,
    // > replacing field values that are already present
    // So we need to make sure to send either no partial headers, or the exact same headers.
    // By adding the metadata of the original resource here, we ensure we send the same headers.
    error.metadata.identifier = metadata.identifier;
    error.metadata.addQuads(metadata.quads());

    return error;
  }
}

/**
 * Verify whether the given {@link Representation} matches the given conditions.
 * If true, add the corresponding ETag to the body metadata.
 * If not, destroy the data stream and throw a {@link NotModifiedHttpError} with the same ETag.
 * If `conditions` is not defined, nothing will happen.
 *
 * This uses the strict conditions check which takes the content type into account;
 * therefore, this should only be called after content negotiation, when it is certain what the output will be.
 *
 * Note that browsers only keep track of one ETag, and the Vary header has no impact on this,
 * meaning the browser could send us the ETag for a Turtle resource even though it is requesting JSON-LD;
 * this is why we have to check ETags after content negotiation.
 *
 * @param body - The representation to compare the conditions against.
 * @param eTagHandler - Used to generate the ETag to return with the 304 response.
 * @param conditions - The conditions to assert.
 */
export function assertReadConditions(body: Representation, eTagHandler: ETagHandler, conditions?: Conditions): void {
  const error = getConditionalNotModifiedError(body.metadata, eTagHandler, conditions);
  if (error) {
    body.data.destroy();
    throw error;
  }
  body.metadata.set(HH.terms.etag, eTagHandler.getETag(body.metadata));
}
