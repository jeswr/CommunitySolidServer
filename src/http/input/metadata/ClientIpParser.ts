import type { HttpRequest } from '../../../server/HttpRequest';
import { parseForwarded } from '../../../util/HeaderUtil';
import { SOLID_HTTP, SOLID_META } from '../../../util/Vocabularies';
import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import { MetadataParser } from './MetadataParser';

/**
 * Determines the IP address of the client that sent the request and stores it as metadata,
 * using the {@link SOLID_HTTP.clientIp} predicate.
 *
 * The address is determined the same way CSS already determines the host/protocol behind a proxy:
 * the RFC 7239 `Forwarded` header is checked first (via {@link parseForwarded}),
 * falling back to the de-facto `X-Forwarded-For` header, and finally to the socket's remote address
 * for direct (non-proxied) connections.
 *
 * As with the other request-derived parsers, the value is added to the {@link SOLID_META.ResponseMetadata}
 * graph so it is never persisted to a resource or serialized into a response.
 */
export class ClientIpParser extends MetadataParser {
  public async handle(input: { request: HttpRequest; metadata: RepresentationMetadata }): Promise<void> {
    const ip = this.findClientIp(input.request);
    if (ip) {
      input.metadata.add(SOLID_HTTP.terms.clientIp, ip, SOLID_META.ResponseMetadata);
    }
  }

  /**
   * Finds the originating client IP address for the given request.
   *
   * @param request - The incoming request.
   *
   * @returns The client IP address, or `undefined` if none could be determined.
   */
  private findClientIp(request: HttpRequest): string | undefined {
    const { headers, socket } = request;

    // RFC 7239 `Forwarded: for=...`, parsed by the same helper used for host/proto.
    const forwardedFor = parseForwarded(headers).for;
    if (forwardedFor) {
      return this.normalize(forwardedFor);
    }

    // De-facto `X-Forwarded-For` header; the first entry is the originating client.
    const xForwardedFor = headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      return this.normalize(xForwardedFor.split(',')[0]);
    }

    // Direct connection without a proxy.
    return socket?.remoteAddress;
  }

  /**
   * Trims whitespace and strips the optional surrounding quotes RFC 7239 allows on a `for` value.
   *
   * @param value - The raw address value.
   *
   * @returns The normalized address.
   */
  private normalize(value: string): string {
    return value.trim().replaceAll(/^"|"$/gu, '');
  }
}
