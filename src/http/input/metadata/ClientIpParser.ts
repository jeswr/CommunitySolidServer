import type { HttpRequest } from '../../../server/HttpRequest';
import { parseForwarded } from '../../../util/HeaderUtil';
import { SOLID_HTTP, SOLID_META } from '../../../util/Vocabularies';
import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import { MetadataParser } from './MetadataParser';

/**
 * Determines the IP address of the client that sent the request
 * and stores it as metadata with the {@link SOLID_HTTP.clientIp} predicate.
 * Uses the RFC 7239 `Forwarded` header, the `X-Forwarded-For` header,
 * and the socket address, in that order.
 */
export class ClientIpParser extends MetadataParser {
  public async handle(input: { request: HttpRequest; metadata: RepresentationMetadata }): Promise<void> {
    const ip = this.findClientIp(input.request);
    if (ip) {
      // This metadata should not be stored
      input.metadata.add(SOLID_HTTP.terms.clientIp, ip, SOLID_META.ResponseMetadata);
    }
  }

  private findClientIp(request: HttpRequest): string | undefined {
    const { headers, socket } = request;

    const forwardedFor = parseForwarded(headers).for;
    if (forwardedFor) {
      return this.normalize(forwardedFor);
    }

    const xForwardedFor = headers['x-forwarded-for'];
    if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
      // The first entry is the originating client
      return this.normalize(xForwardedFor.split(',')[0]);
    }

    return socket?.remoteAddress;
  }

  /**
   * Trims whitespace and strips the optional quotes RFC 7239 allows around a `for` value.
   *
   * @param value - The raw address value.
   *
   * @returns The normalized address.
   */
  private normalize(value: string): string {
    return value.trim().replaceAll(/^"|"$/gu, '');
  }
}
