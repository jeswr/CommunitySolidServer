import { DataFactory } from 'n3';
import { createResponse } from 'node-mocks-http';
import { CookieMetadataWriter } from '../../../../../src/http/output/metadata/CookieMetadataWriter';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { HttpResponse } from '../../../../../src/server/HttpResponse';
import namedNode = DataFactory.namedNode;
import literal = DataFactory.literal;

describe('A CookieMetadataWriter', (): void => {
  const cookieMap = {
    'http://example.com/pred1': { name: 'custom1' },
    'http://example.com/pred2': { name: 'custom2', expirationUri: 'http://example.com/pred2expiration' },
  };
  let metadata: RepresentationMetadata;
  let response: HttpResponse;

  beforeEach(async(): Promise<void> => {
    metadata = new RepresentationMetadata();
    response = createResponse() as HttpResponse;
  });

  // Adds all cookie predicates, including an expiration date for the second cookie.
  function addCookieMetadata(): void {
    const date = new Date('2015-10-21T07:28:00.000Z');
    metadata.add(namedNode('http://example.com/pred1'), literal('my-value'));
    metadata.add(namedNode('http://example.com/pred2'), literal('other-value'));
    metadata.add(namedNode('http://example.com/pred2expiration'), literal(date.toISOString()));
    metadata.add(namedNode('http://example.com/unknown'), literal('unknown-value'));
  }

  it('adds no headers if there is no relevant metadata.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap);
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeaders()).toEqual({});
  });

  it('adds the relevant set-cookie headers with the HttpOnly flag by default.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap);
    addCookieMetadata();
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toEqual([
      'custom1=my-value; Path=/; HttpOnly; SameSite=Lax',
      'custom2=other-value; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; SameSite=Lax',
    ]);
  });

  it('does not set the Secure flag for an http base URL.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap, 'http://example.com/');
    addCookieMetadata();
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toEqual([
      'custom1=my-value; Path=/; HttpOnly; SameSite=Lax',
      'custom2=other-value; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; SameSite=Lax',
    ]);
  });

  it('sets the Secure flag for an https base URL.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap, 'https://example.com/');
    addCookieMetadata();
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toEqual([
      'custom1=my-value; Path=/; HttpOnly; Secure; SameSite=Lax',
      'custom2=other-value; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('allows the Secure flag to be enabled explicitly on an http base URL.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap, 'http://example.com/', true);
    addCookieMetadata();
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toEqual([
      'custom1=my-value; Path=/; HttpOnly; Secure; SameSite=Lax',
      'custom2=other-value; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('allows the Secure flag to be disabled explicitly on an https base URL.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap, 'https://example.com/', false);
    addCookieMetadata();
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toEqual([
      'custom1=my-value; Path=/; HttpOnly; SameSite=Lax',
      'custom2=other-value; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly; SameSite=Lax',
    ]);
  });

  it('allows the HttpOnly flag to be disabled.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap, undefined, undefined, false);
    addCookieMetadata();
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toEqual([
      'custom1=my-value; Path=/; SameSite=Lax',
      'custom2=other-value; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; SameSite=Lax',
    ]);
  });

  it('creates a session cookie when the expiration value is missing.', async(): Promise<void> => {
    const writer = new CookieMetadataWriter(cookieMap);
    metadata.add(namedNode('http://example.com/pred2'), literal('other-value'));
    await expect(writer.handle({ response, metadata })).resolves.toBeUndefined();
    expect(response.getHeader('set-cookie')).toBe('custom2=other-value; Path=/; HttpOnly; SameSite=Lax');
  });
});
