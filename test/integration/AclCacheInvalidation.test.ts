import fetch from 'cross-fetch';
import type { App, ResourceStore } from '../../src/';
import { joinUrl } from '../../src/';
import { AclHelper } from '../util/AclHelper';
import { getResource, putResource } from '../util/FetchUtil';
import { getPort } from '../util/Util';
import {
  getDefaultVariables,
  getPresetConfigPath,
  getTestConfigPath,
  instantiateFromConfig,
} from './Config';

const port = getPort('AclCacheInvalidation');
const baseUrl = `http://localhost:${port}/`;

/**
 * After the ACL cache has been warmed by an authorization decision, an ACL write must be reflected in the very
 * next decision, without waiting for the ttl: a stale entry serving old ACL data would bypass access control.
 */
describe('An ACL cache with write-driven invalidation using in-memory storage', (): void => {
  let app: App;
  let store: ResourceStore;
  let aclHelper: AclHelper;

  beforeAll(async(): Promise<void> => {
    const variables = getDefaultVariables(port, baseUrl);

    const instances = await instantiateFromConfig(
      'urn:solid-server:test:Instances',
      [
        getPresetConfigPath('storage/backend/memory.json'),
        getTestConfigPath('ldp-with-auth.json'),
      ],
      variables,
    ) as Record<string, any>;
    ({ app, store } = instances);

    await app.start();

    aclHelper = new AclHelper(store);
  });

  afterAll(async(): Promise<void> => {
    await app.stop();
  });

  it('reflects a rewrite of a resource ACL on the very next request.', async(): Promise<void> => {
    // Root ACL grants full public access.
    await aclHelper.setSimpleAcl(baseUrl, {
      permissions: { read: true, write: true, append: true, control: true },
      agentClass: 'agent',
      accessTo: true,
      default: true,
    });

    const document = `${baseUrl}doc.txt`;
    await putResource(document, { contentType: 'text/plain', body: 'DATA', exists: false });

    // A dedicated ACL allows reading the document; the read warms the representation cache for doc.txt.acl.
    await aclHelper.setSimpleAcl(document, {
      permissions: { read: true },
      agentClass: 'agent',
      accessTo: true,
    });
    let response = await getResource(document);
    await expect(response.text()).resolves.toBe('DATA');

    // Rewrite that same ACL to remove read access. This write must invalidate the warmed cache entry.
    await aclHelper.setSimpleAcl(document, {
      permissions: { control: true },
      agentClass: 'agent',
      accessTo: true,
    });

    // The next decision must use the new ACL and deny the read, without waiting for the ttl.
    response = await fetch(document);
    expect(response.status).toBe(401);
  });

  it('reflects creation of an intermediate container ACL on the very next request.', async(): Promise<void> => {
    // Root ACL grants full public access, inherited by children through `default`.
    await aclHelper.setSimpleAcl(baseUrl, {
      permissions: { read: true, write: true, append: true, control: true },
      agentClass: 'agent',
      accessTo: true,
      default: true,
    });

    const container = joinUrl(baseUrl, 'protected/');
    const document = joinUrl(container, 'secret.txt');
    await putResource(document, { contentType: 'text/plain', body: 'SECRET', exists: false });

    // The read is allowed by the root ACL and warms the negative existence cache for protected/.acl.
    let response = await getResource(document);
    await expect(response.text()).resolves.toBe('SECRET');

    // Create an intermediate ACL that denies read to children. This write must invalidate the cached
    // negative existence result for protected/.acl so the next probe finds the new document.
    await aclHelper.setSimpleAcl(container, {
      permissions: { control: true },
      agentClass: 'agent',
      default: true,
    });

    // The next decision must find the new intermediate ACL and deny the read, without waiting for the ttl.
    response = await fetch(document);
    expect(response.status).toBe(401);
  });
});
