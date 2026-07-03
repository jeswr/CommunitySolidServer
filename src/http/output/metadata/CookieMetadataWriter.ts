import { serialize } from 'cookie';
import type { NamedNode } from 'n3';
import { DataFactory } from 'n3';
import type { HttpResponse } from '../../../server/HttpResponse';
import { addHeader } from '../../../util/HeaderUtil';
import type { RepresentationMetadata } from '../../representation/RepresentationMetadata';
import { MetadataWriter } from './MetadataWriter';

/**
 * Generates the necessary `Set-Cookie` header if a cookie value is detected in the metadata.
 * The keys of the input `cookieMap` should be the URIs of the predicates
 * used in the metadata when the object is a cookie value.
 * The value of the map are objects that contain the name of the cookie,
 * and the URI that is used to store the expiration date in the metadata, if any.
 * If no expiration date is found in the metadata, none will be set for the cookie,
 * causing it to be a session cookie.
 */
export class CookieMetadataWriter extends MetadataWriter {
  private readonly cookieMap: Map<NamedNode, { name: string; expirationUri?: NamedNode }>;
  private readonly secure: boolean;
  private readonly httpOnly: boolean;

  /**
   * @param cookieMap - A map linking metadata predicate URIs to cookie definitions.
   * @param baseUrl - Base URL of the server. Used to enable the `Secure` flag when the server runs over `https`.
   * @param secure - Explicitly enable/disable the `Secure` cookie flag.
   *                 When undefined, the flag is derived from `baseUrl` (enabled for `https` deployments).
   * @param httpOnly - Enable/disable the `HttpOnly` cookie flag. Defaults to `true`.
   */
  public constructor(
    cookieMap: Record<string, { name: string; expirationUri?: string }>,
    baseUrl?: string,
    secure?: boolean,
    httpOnly = true,
  ) {
    super();
    this.cookieMap = new Map<NamedNode, { name: string; expirationUri?: NamedNode }>(Object.entries(cookieMap)
      .map(([ uri, { name, expirationUri }]): [ NamedNode, { name: string; expirationUri?: NamedNode } ] =>
        [
          DataFactory.namedNode(uri),
          {
            name,
            expirationUri: expirationUri ? DataFactory.namedNode(expirationUri) : undefined,
          },
        ]));
    // Only enable the `Secure` flag when the server is behind `https`,
    // as an `https`-only cookie would never be sent to an `http` deployment.
    this.secure = secure ?? Boolean(baseUrl?.startsWith('https:'));
    this.httpOnly = httpOnly;
  }

  public async handle(input: { response: HttpResponse; metadata: RepresentationMetadata }): Promise<void> {
    const { response, metadata } = input;
    for (const [ uri, { name, expirationUri }] of this.cookieMap.entries()) {
      const value = metadata.get(uri)?.value;
      if (value) {
        const expiration = expirationUri && metadata.get(expirationUri)?.value;
        const expires = typeof expiration === 'string' ? new Date(expiration) : undefined;
        // `HttpOnly` prevents client-side JavaScript from reading the cookie, mitigating session theft via XSS.
        // This is safe because the account UI never reads the cookie through `document.cookie`;
        // the browser attaches it automatically, and the JSON API also returns the value in an `authorization`
        // field for use as a `CSS-Account-Token` header.
        // `Secure` restricts the cookie to `https`; it is only enabled when the server runs over `https`,
        // since an `https`-only cookie would never be sent to an `http` deployment (breaking login there).
        // SameSite: Lax makes it so the cookie gets sent if the origin is the server,
        // or if the browser navigates there from another site.
        // Setting the path to `/` so it applies to the entire server.
        addHeader(response, 'Set-Cookie', serialize(name, value, {
          path: '/',
          sameSite: 'lax',
          expires,
          httpOnly: this.httpOnly,
          secure: this.secure,
        }));
      }
    }
  }
}
