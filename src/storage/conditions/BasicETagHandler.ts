import type { RepresentationMetadata } from '../../http/representation/RepresentationMetadata';
import { DC } from '../../util/Vocabularies';
import type { ETagHandler } from './ETagHandler';

/**
 * Standard implementation of {@link ETagHandler}.
 * ETags are constructed by combining the last modified date with the content type of the representation.
 */
export class BasicETagHandler implements ETagHandler {
  public getETag(metadata: RepresentationMetadata): string | undefined {
    const modified = metadata.get(DC.terms.modified);
    const { contentType } = metadata;
    if (modified && contentType) {
      const date = new Date(modified.value);
      return `"${date.getTime()}-${contentType}"`;
    }
  }

  public matchesETag(metadata: RepresentationMetadata, eTag: string, strict: boolean): boolean {
    const modified = metadata.get(DC.terms.modified);
    if (!modified) {
      return false;
    }
    const date = new Date(modified.value);
    const { contentType } = metadata;

    // RFC 9110, §8.8.3.2: an `If-None-Match` header requires a weak comparison,
    // meaning an optional `W/` prefix, as added by intermediaries such as compressing proxies, needs to be ignored.
    const strippedETag = eTag.startsWith('W/') ? eTag.slice(2) : eTag;

    // Slicing of the double quotes
    const value = strippedETag.slice(1, -1);
    // Only split on the first `-`, as content types can also contain a `-`, e.g., `application/n-quads`
    const splitIndex = value.indexOf('-');
    const eTagTimestamp = splitIndex >= 0 ? value.slice(0, splitIndex) : value;
    const eTagContentType = splitIndex >= 0 ? value.slice(splitIndex + 1) : undefined;

    return eTagTimestamp === `${date.getTime()}` && (!strict || eTagContentType === contentType);
  }

  public sameResourceState(eTag1: string, eTag2: string): boolean {
    // Since we base the ETag on the last modified date,
    // we know the ETags match as long as the date part is the same.
    return eTag1.split('-')[0] === eTag2.split('-')[0];
  }
}
