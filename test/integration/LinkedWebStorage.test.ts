import fetch from 'cross-fetch';
import type { JWK, KeyLike } from 'jose';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { App } from '../../src/init/App';
import type { ResourceStore } from '../../src/storage/ResourceStore';
import { AclHelper } from '../util/AclHelper';
import { AcpHelper } from '../util/AcpHelper';
import { getPort } from '../util/Util';
import { getDefaultVariables, getPresetConfigPath, getTestConfigPath, instantiateFromConfig } from './Config';

const port = getPort('LinkedWebStorage');
const baseUrl = `http://localhost:${port}/`;

const LWS = 'https://www.w3.org/ns/lws#';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let result = '';
  while (value > 0n) {
    result = BASE58[Number(value % 58n)] + result;
    value /= 58n;
  }
  return result;
}

interface Agent {
  did: string;
  key: KeyLike;
}

/**
 * Generates a P-256 key and the corresponding did:key identifier.
 */
async function createAgent(): Promise<Agent> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk: JWK = await exportJWK(publicKey);
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  const prefix = (y.at(-1)! & 1) === 1 ? 3 : 2;
  const did = `did:key:z${encodeBase58(Buffer.concat([ Buffer.from([ 0x80, 0x24, prefix ]), x ]))}`;
  return { did, key: privateKey };
}

async function exchange(agent: Agent, resource = baseUrl): Promise<Response> {
  const credential = await new SignJWT({ client_id: agent.did })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setSubject(agent.did)
    .setIssuer(agent.did)
    .setAudience(baseUrl)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(agent.key);
  return fetch(`${baseUrl}.well-known/lws/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      resource,
      subject_token: credential,
      subject_token_type: TOKEN_TYPE_JWT,
    }).toString(),
  });
}

async function getAccessToken(agent: Agent): Promise<string> {
  const response = await exchange(agent);
  expect(response.status).toBe(200);
  return (await response.json() as { access_token: string }).access_token;
}

function getLinks(response: Response): string[] {
  return (response.headers.get('link') ?? '').split(/,\s*(?=<)/u);
}

const protocols: [string, { dual: boolean; configs: string[] }][] = [
  [ 'LWS', { dual: false, configs: [
    'ldp/authentication/lws.json',
    'ldp/handler/lws.json',
    'ldp/metadata-writer/lws.json',
    'util/representation-conversion/lws.json',
  ]}],
  [ 'Solid and LWS', { dual: true, configs: [
    'ldp/authentication/solid-lws.json',
    'ldp/handler/solid-lws.json',
    'ldp/metadata-writer/solid-lws.json',
    'util/representation-conversion/solid-lws.json',
  ]}],
];

const authorizations: [string, { configs: string[]; grant: (store: ResourceStore, agent: string) => Promise<void> }][] =
  [
    [ 'WAC', {
      configs: [ 'ldp/authorization/webacl.json', 'util/auxiliary/acl.json' ],
      grant: async(store, agent): Promise<void> => new AclHelper(store).setSimpleAcl(baseUrl, {
        permissions: { read: true, write: true, append: true, control: true },
        agent: `<${agent}>`,
        accessTo: true,
        default: true,
      }),
    }],
    [ 'ACP', {
      configs: [ 'ldp/authorization/acp.json', 'util/auxiliary/acr.json' ],
      grant: async(store, agent): Promise<void> => {
        const helper = new AcpHelper(store);
        const policy = helper.createPolicy({
          allow: [ 'read', 'append', 'write', 'control' ],
          anyOf: [ helper.createMatcher({ agent: `<${agent}>` }) ],
        });
        await helper.setAcp(baseUrl, helper.createAcr({
          resource: baseUrl,
          policies: [ policy ],
          memberPolicies: [ policy ],
        }));
      },
    }],
  ];

const combinations = protocols.flatMap(([ protocol, protocolArgs ]): [string, string, any, any][] =>
  authorizations.map(([ authorization, authArgs ]): [string, string, any, any] =>
    [ protocol, authorization, protocolArgs, authArgs ]));

describe.each(combinations)('A %s server using %s', (protocol, authorization, protocolArgs, authArgs): void => {
  let app: App;
  let alice: Agent;
  let bob: Agent;
  let aliceToken: string;
  const container = `${baseUrl}container/`;
  let resource: string;

  beforeAll(async(): Promise<void> => {
    const instances = await instantiateFromConfig(
      'urn:solid-server:test:Instances',
      [
        getTestConfigPath('lws-server.json'),
        ...[ ...protocolArgs.configs, ...authArgs.configs ].map(getPresetConfigPath),
      ],
      getDefaultVariables(port, baseUrl),
    ) as Record<string, any>;
    let store: ResourceStore;
    ({ app, store } = instances);
    await app.start();

    alice = await createAgent();
    bob = await createAgent();
    await authArgs.grant(store, alice.did);
  });

  afterAll(async(): Promise<void> => {
    await app.stop();
  });

  it('serves the storage description on the storage URI.', async(): Promise<void> => {
    const response = await fetch(baseUrl, { headers: { accept: 'application/lws+cid' }});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/lws+cid');
    expect(getLinks(response)).toContain(`<${baseUrl}>; rel="${LWS}storage"`);
    const description = await response.json();
    expect(description).toEqual(expect.objectContaining({
      id: baseUrl,
      type: 'Storage',
      service: expect.arrayContaining([{ type: 'StorageRoot', serviceEndpoint: baseUrl }]),
    }));
  });

  it('serves the authorization server metadata.', async(): Promise<void> => {
    const response = await fetch(`${baseUrl}.well-known/lws-configuration`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      issuer: baseUrl,
      token_endpoint: `${baseUrl}.well-known/lws/token`,
      jwks_uri: `${baseUrl}.well-known/lws/jwks`,
      grant_types_supported: [ TOKEN_EXCHANGE ],
    }));
  });

  it('challenges unauthenticated requests.', async(): Promise<void> => {
    const response = await fetch(container);
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate');
    expect(challenge).toContain(`as_uri="${baseUrl}"`);
    expect(challenge).toContain(`realm="${baseUrl}"`);
    expect(challenge).not.toContain('error=');
  });

  it('exchanges a did:key credential for an access token.', async(): Promise<void> => {
    const response = await exchange(alice);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as Record<string, string>;
    expect(body.token_type).toBe('Bearer');
    aliceToken = body.access_token;
  });

  it('rejects token requests for unknown storages.', async(): Promise<void> => {
    const response = await exchange(alice, 'https://unknown.example/');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ error: 'invalid_target' }));
  });

  it('rejects invalid access tokens.', async(): Promise<void> => {
    const response = await fetch(container, { headers: { authorization: `Bearer ${aliceToken}x` }});
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('allows the owner to create a container.', async(): Promise<void> => {
    const response = await fetch(container, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, link: `<${LWS}Container>; rel="type"` },
    });
    expect(response.status).toBe(201);
  });

  it('allows the owner to create a data resource.', async(): Promise<void> => {
    const response = await fetch(container, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
      body: 'some content',
    });
    expect(response.status).toBe(201);
    resource = response.headers.get('location')!;
    const links = getLinks(response);
    expect(links).toContain(`<${container}>; rel="up"`);
    expect(links).toContain(`<${LWS}DataResource>; rel="type"`);
    expect(links).toContain(`<${baseUrl}>; rel="${LWS}storage"`);
  });

  it('represents containers as application/lws+json.', async(): Promise<void> => {
    const response = await fetch(container, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/lws+json' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/lws+json');
    const body = await response.json();
    expect(body).toEqual(expect.objectContaining({ id: container, type: 'Container', totalItems: 1 }));
    expect(body.items[0]).toEqual(
      expect.objectContaining({ id: resource, type: 'DataResource', format: 'text/plain' }),
    );
  });

  it(`${protocolArgs.dual ? 'keeps the LDP' : 'uses the LWS'} representation for JSON-LD.`, async(): Promise<void> => {
    const response = await fetch(container, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/ld+json' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // The LDP representation is a JSON-LD array, the LWS representation an object
    expect(Array.isArray(body)).toBe(protocolArgs.dual);
  });

  const wildcardResult = protocolArgs.dual ? 'the root container' : 'the storage description';

  it(`returns ${wildcardResult} for */*.`, async(): Promise<void> => {
    const response = await fetch(baseUrl, { headers: { authorization: `Bearer ${aliceToken}`, accept: '*/*' }});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(protocolArgs.dual ? 'text/turtle' : 'application/lws+cid');
  });

  it('modifies linksets with JSON Merge Patch.', async(): Promise<void> => {
    const head = await fetch(resource, { method: 'HEAD', headers: { authorization: `Bearer ${aliceToken}` }});
    const linkset = /<([^>]+)>; rel="linkset"/u.exec(head.headers.get('link')!)![1];

    let response = await fetch(linkset, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/merge-patch+json' },
      body: JSON.stringify({ linkset: [{ anchor: resource, author: [{ href: 'https://example.com/alice' }]}]}),
    });
    expect(response.status).toBe(204);

    response = await fetch(linkset, {
      headers: { authorization: `Bearer ${aliceToken}`, accept: 'application/linkset+json' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.linkset[0].author).toEqual([{ href: 'https://example.com/alice' }]);
  });

  it('returns 204 after modifying a resource.', async(): Promise<void> => {
    const response = await fetch(resource, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'text/plain' },
      body: 'new content',
    });
    expect(response.status).toBe(204);
  });

  it('denies access to other agents.', async(): Promise<void> => {
    const bobToken = await getAccessToken(bob);
    const response = await fetch(resource, { headers: { authorization: `Bearer ${bobToken}` }});
    expect(response.status).toBe(403);
  });

  it('allows the owner to delete resources.', async(): Promise<void> => {
    const response = await fetch(resource, { method: 'DELETE', headers: { authorization: `Bearer ${aliceToken}` }});
    expect(response.status).toBe(204);
  });
});
