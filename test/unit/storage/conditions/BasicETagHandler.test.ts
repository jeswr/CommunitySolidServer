import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import { BasicETagHandler } from '../../../../src/storage/conditions/BasicETagHandler';
import { DC } from '../../../../src/util/Vocabularies';

describe('A BasicETagHandler', (): void => {
  const now = new Date();
  const contentType = 'text/turtle';
  const eTag = `"${now.getTime()}-${contentType}"`;
  let metadata: RepresentationMetadata;
  const handler = new BasicETagHandler();

  beforeEach(async(): Promise<void> => {
    metadata = new RepresentationMetadata();
    metadata.add(DC.terms.modified, now.toISOString());
    metadata.contentType = 'text/turtle';
  });

  it('can generate ETags.', async(): Promise<void> => {
    expect(handler.getETag(metadata)).toBe(eTag);
  });

  it('does not generate an ETag if the last modified date is missing.', async(): Promise<void> => {
    metadata.removeAll(DC.terms.modified);
    expect(handler.getETag(metadata)).toBeUndefined();
  });

  it('does not generate an ETag if the content-type is missing.', async(): Promise<void> => {
    metadata.contentType = undefined;
    expect(handler.getETag(metadata)).toBeUndefined();
  });

  it('can validate an ETag against metadata.', async(): Promise<void> => {
    expect(handler.matchesETag(metadata, eTag, true)).toBe(true);
  });

  it('requires a last modified date when comparing metadata with an ETag.', async(): Promise<void> => {
    metadata.removeAll(DC.terms.modified);
    expect(handler.matchesETag(metadata, eTag, true)).toBe(false);
  });

  it('requires a content type when comparing metadata with an ETag.', async(): Promise<void> => {
    metadata.contentType = undefined;
    expect(handler.matchesETag(metadata, eTag, true)).toBe(false);
  });

  it('does not require a content type when comparing metadata with an ETag.', async(): Promise<void> => {
    metadata.contentType = undefined;
    expect(handler.matchesETag(metadata, eTag, false)).toBe(true);
  });

  it('matches weak ETags according to the RFC 9110 weak comparison.', async(): Promise<void> => {
    expect(handler.matchesETag(metadata, `W/${eTag}`, true)).toBe(true);
    expect(handler.matchesETag(metadata, `W/${eTag}`, false)).toBe(true);
  });

  it('does not match weak ETags corresponding to a different resource state.', async(): Promise<void> => {
    const differentTime = `W/"${now.getTime() + 1}-${contentType}"`;
    expect(handler.matchesETag(metadata, differentTime, true)).toBe(false);
    expect(handler.matchesETag(metadata, differentTime, false)).toBe(false);
  });

  it('only ignores the content type of weak ETags when not comparing on representation level.', async():
  Promise<void> => {
    const differentType = `W/"${now.getTime()}-text/plain"`;
    expect(handler.matchesETag(metadata, differentType, true)).toBe(false);
    expect(handler.matchesETag(metadata, differentType, false)).toBe(true);
  });

  it('can validate generated ETags for content types containing hyphens.', async(): Promise<void> => {
    for (const type of [ 'text/turtle', 'application/n-quads', 'application/n-triples', 'application/ld+json' ]) {
      metadata.contentType = type;
      const generated = handler.getETag(metadata)!;
      expect(generated).toBe(`"${now.getTime()}-${type}"`);
      expect(handler.matchesETag(metadata, generated, true)).toBe(true);
      expect(handler.matchesETag(metadata, generated, false)).toBe(true);
    }
  });

  it('keeps the full content type when it contains multiple hyphens.', async(): Promise<void> => {
    metadata.contentType = 'application/x-fake-type';
    expect(handler.matchesETag(metadata, `"${now.getTime()}-application/x-fake-type"`, true)).toBe(true);
    expect(handler.matchesETag(metadata, `"${now.getTime()}-application/x-fake"`, true)).toBe(false);
  });

  it('does not match malformed ETags.', async(): Promise<void> => {
    expect(handler.matchesETag(metadata, 'no-quotes', true)).toBe(false);
    expect(handler.matchesETag(metadata, 'no-quotes', false)).toBe(false);
    expect(handler.matchesETag(metadata, '""', true)).toBe(false);
    expect(handler.matchesETag(metadata, `"${now.getTime()}"`, true)).toBe(false);
  });

  it('does not require a content type in the ETag when not comparing on representation level.', async():
  Promise<void> => {
    expect(handler.matchesETag(metadata, `"${now.getTime()}"`, false)).toBe(true);
  });

  it('can verify if 2 ETags reference the same resource state.', async(): Promise<void> => {
    expect(handler.sameResourceState(eTag, eTag)).toBe(true);
    expect(handler.sameResourceState(eTag, `"${now.getTime()}-text/plain"`)).toBe(true);
    expect(handler.sameResourceState(eTag, `"${now.getTime() + 1}-${contentType}"`)).toBe(false);
  });
});
