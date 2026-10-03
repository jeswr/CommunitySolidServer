# Linked Web Storage

The server can be configured to serve the [Linked Web Storage](https://w3c.github.io/lws-protocol/lws10-core/) (LWS)
protocol, a W3C draft that builds on the ideas of the Solid Protocol.
The implementation follows the LWS editor's draft of 28 September 2026.
As LWS is still a draft, the behaviour described here may change along with the specification.

## Configurations

There are four configurations that enable LWS.
All of them store data on disk and allow the creation of accounts and pods, just like `file.json`.

| Configuration        | Protocols    | Authorization |
|----------------------|--------------|---------------|
| `lws.json`           | LWS          | WAC           |
| `lws-acp.json`       | LWS          | ACP           |
| `solid-lws.json`     | Solid + LWS  | WAC           |
| `solid-lws-acp.json` | Solid + LWS  | ACP           |

For example, to start an LWS server on port 3000 that stores its data in the `data` folder:

```shell
npx @solid/community-server -c @css:config/lws.json -f data/
```

Every pod is an LWS storage. In the dual configurations, Solid and LWS clients can work with the same pods.

## Storages and discovery

The URI of a storage is the URI of the root container of the pod.
Every response contains a `Link` header with relation `https://www.w3.org/ns/lws#storage` pointing to the storage.

A `GET` request to the storage URI with an `Accept` header that prefers `application/lws+cid`,
or without an `Accept` header, returns the storage description.
Other requests return the root container.
In the LWS-only configurations, a request that only accepts `*/*` also receives the storage description;
in the dual configurations it receives the root container, as Solid clients expect.
The storage description is public, so clients can discover the services of a storage without credentials.

## Containers and resources

Containers are represented as `application/lws+json`.
In the LWS-only configurations, `application/ld+json` and `application/json` return the same document.
In the dual configurations, `application/ld+json` keeps returning the LDP representation that Solid clients expect,
so LWS clients need to request `application/lws+json` or `application/json`.

Containers can be created with a `POST` or `PUT` request
that has a `Link: <https://www.w3.org/ns/lws#Container>; rel="type"` header,
next to the LDP container types.

Responses contain the `up`, `type`, and `linkset` links required by LWS,
and successful modifications return `204 No Content`.
JSON resources can be modified with [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386) requests.

## Linksets

The metadata of a resource is exposed as a [linkset](https://www.rfc-editor.org/rfc/rfc9264),
linked from the resource with `rel="linkset"`.
This is the same resource as the [description resource](metadata.md) of the resource,
which can be requested as `application/linkset+json`,
and modified with a JSON Merge Patch request on that linkset.
Server-managed links, such as the containment triples, can not be modified.

## Authorization

The server contains an LWS authorization server.
Its metadata can be found at `/.well-known/lws-configuration`.
A `401` response contains a `WWW-Authenticate` header with an `as_uri` parameter pointing to it,
and a `realm` parameter with the storage URI.

Clients obtain an access token by exchanging an authentication credential at the token endpoint
using [OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693),
with the storage URI as `resource` parameter.
The following authentication suites are supported:

* Self-signed `did:key` credentials (`urn:ietf:params:oauth:token-type:jwt`).
* Self-issued credentials of agents with an HTTPS identifier,
  whose controlled identifier document contains the verification key (`urn:ietf:params:oauth:token-type:jwt`).
* OpenID Connect ID tokens (`urn:ietf:params:oauth:token-type:id_token`).
  The controlled identifier document of the subject needs to contain an `https://www.w3.org/ns/lws#OpenIdProvider` service
  pointing to the issuer.
  WebIDs with a `solid:oidcIssuer` triple are also accepted,
  so the accounts of the identity provider of this server, and of other Solid identity providers, can be used.

The resulting access tokens are presented as `Bearer` tokens.
The agent in the access token is used as the WebID in WAC and ACP policies,
so access can be granted to a `did:key` identifier the same way as to a WebID.

In the dual configurations, Solid-OIDC DPoP and Bearer tokens are also accepted.
Bearer tokens that have a `webid` claim are treated as Solid-OIDC tokens.

## Not supported

The following parts of LWS are not supported yet:

* Pagination of containers.
* Access requests and grants.
* LWS webhook notifications. The Solid notification channels are still available.
* Recursive deletion with the `Depth` header.
