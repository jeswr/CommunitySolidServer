'use strict';
/**
 * Prepares a booted CSS instance for benchmarking: creates an account with a pod,
 * obtains a DPoP-bound access token through client credentials, and creates the requested
 * containers with a public read/write ACL, so the measured request path contains no token signing.
 * The `jose` argument of `setupPod` must be resolved from the measured server's dependency tree;
 * `authed` in the result performs a fetch authenticated as the pod owner.
 *
 * CLI usage: node bench-setup.js <baseUrl> [podName]
 */
const { randomUUID } = require('node:crypto');

const PUBLIC_ACL = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#public> a acl:Authorization;
  acl:agentClass foaf:Agent;
  acl:accessTo <./>;
  acl:default <./>;
  acl:mode acl:Read, acl:Write, acl:Control.
`;

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function setupPod({ baseUrl, podName = 'bench', jose, containers = [ 'scratch/' ]}) {
  // 1. Account controls (no auth)
  let controls = (await json(await fetch(new URL('.account/', baseUrl)))).controls;
  // 2. Create account
  const created = await json(await fetch(controls.account.create, { method: 'POST' }));
  if (!created.authorization) {
    throw new Error(`No authorization in account create response: ${JSON.stringify(created)}`);
  }
  const authHeader = { authorization: `CSS-Account-Token ${created.authorization}` };
  // 3. Authenticated controls
  controls = (await json(await fetch(new URL('.account/', baseUrl), { headers: authHeader }))).controls;
  // 4. Password login (required for the account to be complete)
  const email = `bench-${randomUUID().slice(0, 8)}@example.com`;
  await json(await fetch(controls.password.create, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'bench-password!1' }),
  }));
  // 5. Pod
  const pod = await json(await fetch(controls.account.pod, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ name: podName }),
  }));
  // 6. Client credentials
  const cc = await json(await fetch(controls.account.clientCredentials, {
    method: 'POST',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bench-token', webId: pod.webId }),
  }));
  // 7. DPoP-bound access token
  const { privateKey, publicKey } = await jose.generateKeyPair('ES256');
  const publicJwk = await jose.exportJWK(publicKey);
  async function dpop(htm, htu) {
    return new jose.SignJWT({ htu, htm, jti: randomUUID() })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk })
      .setIssuedAt()
      .sign(privateKey);
  }
  const tokenUrl = new URL('.oidc/token', baseUrl).href;
  const basic = Buffer.from(`${encodeURIComponent(cc.id)}:${encodeURIComponent(cc.secret)}`).toString('base64');
  const tok = await json(await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      dpop: await dpop('POST', tokenUrl),
    },
    body: 'grant_type=client_credentials&scope=webid',
  }));
  if (!tok.access_token) {
    throw new Error(`No access token: ${JSON.stringify(tok)}`);
  }
  async function authed(url, init = {}) {
    return fetch(url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `DPoP ${tok.access_token}`,
        dpop: await dpop(init.method || 'GET', url),
      },
    });
  }
  // 8. Public containers
  const containerUrls = {};
  for (const dir of containers) {
    const url = new URL(dir, pod.pod).href;
    let res = await authed(url, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '' });
    if (res.status >= 400) {
      throw new Error(`PUT ${url}: ${res.status} ${await res.text()}`);
    }
    res = await authed(new URL('.acl', url).href, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: PUBLIC_ACL });
    if (res.status >= 400) {
      throw new Error(`PUT ${url}.acl: ${res.status} ${await res.text()}`);
    }
    containerUrls[dir.replace(/\/$/u, '')] = url;
  }
  return { podRoot: pod.pod, webId: pod.webId, email, accessToken: tok.access_token, containers: containerUrls, authed };
}

module.exports = { setupPod };

if (require.main === module) {
  const [ baseUrl = 'http://localhost:3456/', podName = 'bench' ] = process.argv.slice(2);
  // eslint-disable-next-line global-require
  const jose = require('jose');
  setupPod({ baseUrl, podName, jose }).then(
    result => console.log(JSON.stringify(result, null, 2)),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
