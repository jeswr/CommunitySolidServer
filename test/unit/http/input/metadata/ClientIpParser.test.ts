import { ClientIpParser } from '../../../../../src/http/input/metadata/ClientIpParser';
import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type { HttpRequest } from '../../../../../src/server/HttpRequest';
import { SOLID_HTTP, SOLID_META } from '../../../../../src/util/Vocabularies';

describe('A ClientIpParser', (): void => {
  const parser = new ClientIpParser();
  let request: HttpRequest;
  let metadata: RepresentationMetadata;

  beforeEach(async(): Promise<void> => {
    request = { headers: {}} as HttpRequest;
    metadata = new RepresentationMetadata();
  });

  it('does nothing if no address can be determined.', async(): Promise<void> => {
    await parser.handle({ request, metadata });
    expect(metadata.quads()).toHaveLength(0);
  });

  it('stores the socket remote address for direct connections.', async(): Promise<void> => {
    request = { headers: {}, socket: { remoteAddress: '9.9.9.9' }} as unknown as HttpRequest;
    await parser.handle({ request, metadata });
    expect(metadata.get(SOLID_HTTP.terms.clientIp)?.value).toBe('9.9.9.9');
  });

  it('stores the address as non-persisted response metadata.', async(): Promise<void> => {
    request = { headers: {}, socket: { remoteAddress: '9.9.9.9' }} as unknown as HttpRequest;
    await parser.handle({ request, metadata });
    expect(metadata.quads(null, SOLID_HTTP.terms.clientIp, null, SOLID_META.terms.ResponseMetadata))
      .toHaveLength(1);
  });

  it('prefers the first entry of the X-Forwarded-For header.', async(): Promise<void> => {
    request = {
      headers: { 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8 ' },
      socket: { remoteAddress: '9.9.9.9' },
    } as unknown as HttpRequest;
    await parser.handle({ request, metadata });
    expect(metadata.get(SOLID_HTTP.terms.clientIp)?.value).toBe('1.2.3.4');
  });

  it('ignores an empty X-Forwarded-For header.', async(): Promise<void> => {
    request = {
      headers: { 'x-forwarded-for': '' },
      socket: { remoteAddress: '9.9.9.9' },
    } as unknown as HttpRequest;
    await parser.handle({ request, metadata });
    expect(metadata.get(SOLID_HTTP.terms.clientIp)?.value).toBe('9.9.9.9');
  });

  it('prefers the RFC 7239 Forwarded header and strips quotes.', async(): Promise<void> => {
    request = {
      headers: { forwarded: 'for="1.2.3.4";proto=https', 'x-forwarded-for': '5.6.7.8' },
      socket: { remoteAddress: '9.9.9.9' },
    } as unknown as HttpRequest;
    await parser.handle({ request, metadata });
    expect(metadata.get(SOLID_HTTP.terms.clientIp)?.value).toBe('1.2.3.4');
  });
});
