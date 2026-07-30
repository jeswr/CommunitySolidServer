import request from 'supertest';
import type { App } from '../../src/init/App';
import { getPort } from '../util/Util';
import { getDefaultVariables, getTestConfigPath, instantiateFromConfig } from './Config';

const port = getPort('OidcCache');
const baseUrl = `http://localhost:${port}`;

// Prevent panva/node-oidc-provider from emitting DraftWarning
jest.spyOn(process, 'emitWarning').mockImplementation();

describe('A server with a configured IDP', (): void => {
  let app: App;

  beforeAll(async(): Promise<void> => {
    const instances = await instantiateFromConfig(
      'urn:solid-server:test:Instances',
      [
        getTestConfigPath('server-memory.json'),
      ],
      getDefaultVariables(port),
    ) as { app: App };

    ({ app } = instances);
    await app.start();
  });

  afterAll(async(): Promise<void> => {
    await app.stop();
  });

  it('makes the OIDC discovery document publicly cacheable without a spurious Vary.', async(): Promise<void> => {
    const res = await request(baseUrl).get('/.well-known/openid-configuration').expect(200);
    expect(res.header['cache-control']).toBe('public, max-age=3600');
    expect(res.header.vary).toBe('Origin');
  });

  it('makes the JWKS document publicly cacheable with a shorter lifetime.', async(): Promise<void> => {
    const res = await request(baseUrl).get('/.oidc/jwks').expect(200);
    expect(res.header['cache-control']).toBe('public, max-age=600');
    expect(res.header.vary).toBe('Origin');
  });

  it('does not cache the discovery document for other methods.', async(): Promise<void> => {
    const res = await request(baseUrl).post('/.well-known/openid-configuration');
    expect(res.header['cache-control']).toBeUndefined();
  });

  it('does not make other IDP resources cacheable.', async(): Promise<void> => {
    const res = await request(baseUrl).get('/.account/');
    expect(res.header['cache-control']).toBeUndefined();
    expect(res.header.vary).toMatch(/(^|,)\s*Authorization\s*(,|$)/iu);
  });
});
