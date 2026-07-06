import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { NamedNode } from 'n3';
import { DataFactory, Parser, Store } from 'n3';
import { WebSocket } from 'ws';
import type { App } from '../../src/init/App';
import { joinUrl } from '../../src/util/PathUtil';
import { readJsonStream } from '../../src/util/StreamUtil';
import { AS, NOTIFY, RDF } from '../../src/util/Vocabularies';
import { expectNotification, subscribe } from '../util/NotificationUtil';
import { getPort } from '../util/Util';
import {
  getDefaultVariables,
  getPresetConfigPath,
  getTestConfigPath,
  getTestFolder,
  instantiateFromConfig,
  removeFolder,
} from './Config';
import quad = DataFactory.quad;
import namedNode = DataFactory.namedNode;

const port = getPort('ClusterNotifications');
const baseUrl = `http://localhost:${port}/`;
const clientPort = getPort('ClusterNotifications-client');
const target = `http://localhost:${clientPort}/`;
const webId = 'http://example.com/card/#me';

const rootFilePath = getTestFolder('ClusterNotifications');

async function readChunk(reader: ReadableStreamDefaultReader): Promise<Store> {
  const decoder = new TextDecoder();
  const parser = new Parser();
  const { value } = await reader.read();
  const notification = decoder.decode(value);
  return new Store(parser.parse(notification));
}

/**
 * These tests validate the opt-in cluster notification wiring of `http/notifications/cluster/memory.json`:
 * the split WebSocket/Webhook listening handlers and the `ClusterActivityEmitter` in front of the
 * connection-pinned channel types.
 * With the in-memory bus everything stays within this single process,
 * so every channel type is expected to behave exactly as it does with the default wiring,
 * receiving every notification exactly once.
 */
describe('A server with cluster notifications using the in-memory bus', (): void => {
  let app: App;
  const topic = joinUrl(baseUrl, '/foo');
  let storageDescriptionUrl: string;
  let webSocketSubscriptionUrl: string;
  let webhookSubscriptionUrl: string;
  let clientServer: Server;
  const webhookNotifications: unknown[] = [];

  beforeAll(async(): Promise<void> => {
    const variables = {
      ...getDefaultVariables(port, baseUrl),
      'urn:solid-server:default:variable:rootFilePath': rootFilePath,
    };

    // Create and start the server
    const instances = await instantiateFromConfig(
      'urn:solid-server:test:Instances',
      [
        getPresetConfigPath('storage/backend/memory.json'),
        getPresetConfigPath('util/resource-locker/memory.json'),
        getTestConfigPath('cluster-notifications.json'),
      ],
      variables,
    ) as Record<string, any>;
    ({ app } = instances);

    await app.start();

    // Start the client server that will receive the webhooks
    clientServer = createServer((request, response): void => {
      readJsonStream(request)
        .then((json): void => {
          webhookNotifications.push(json);
          response.writeHead(200);
          response.end();
        })
        .catch((): void => {
          response.writeHead(500);
          response.end();
        });
    });
    clientServer.listen(clientPort);
  });

  afterAll(async(): Promise<void> => {
    // Drop any keep-alive connections so `close` resolves instead of waiting for them to time out
    clientServer.closeAllConnections();
    await new Promise<void>((resolve): void => {
      clientServer.close((): void => resolve());
    });
    await app.stop();
    await removeFolder(rootFilePath);
  });

  it('exposes subscription services for both channel types.', async(): Promise<void> => {
    let response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    const linkHeader = response.headers.get('link');
    expect(linkHeader).not.toBeNull();
    const match = /<([^>]+)>; rel="http:\/\/www\.w3\.org\/ns\/solid\/terms#storageDescription"/u.exec(linkHeader!);
    expect(match).not.toBeNull();
    storageDescriptionUrl = match![1];

    response = await fetch(storageDescriptionUrl, { headers: { accept: 'text/turtle' }});
    expect(response.status).toBe(200);
    const quads = new Store(new Parser().parse(await response.text()));
    const subscriptions = quads.getObjects(null, NOTIFY.terms.subscription, null);

    const webSocketSubscriptions = subscriptions.filter((channel): boolean => quads.has(
      quad(channel as NamedNode, NOTIFY.terms.channelType, NOTIFY.terms.WebSocketChannel2023),
    ));
    expect(webSocketSubscriptions).toHaveLength(1);
    webSocketSubscriptionUrl = webSocketSubscriptions[0].value;

    const webhookSubscriptions = subscriptions.filter((channel): boolean => quads.has(
      quad(channel as NamedNode, NOTIFY.terms.channelType, NOTIFY.terms.WebhookChannel2023),
    ));
    expect(webhookSubscriptions).toHaveLength(1);
    webhookSubscriptionUrl = webhookSubscriptions[0].value;
  });

  it('delivers a change exactly once to each subscribed channel type.', async(): Promise<void> => {
    const { receiveFrom } =
      await subscribe(NOTIFY.WebSocketChannel2023, webId, webSocketSubscriptionUrl, topic) as any;
    await subscribe(NOTIFY.WebhookChannel2023, webId, webhookSubscriptionUrl, topic, { [NOTIFY.sendTo]: target });

    const socket = new WebSocket(receiveFrom);
    const socketMessages: Buffer[] = [];
    const firstMessage = new Promise<void>((resolve): any => socket.once('message', (): void => resolve()));
    socket.on('message', (message): number => socketMessages.push(message as Buffer));
    await new Promise<void>((resolve): any => socket.on('open', resolve));

    const firstWebhook = new Promise<void>((resolve): any => clientServer.once('request', (): void => resolve()));

    const response = await fetch(topic, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'abc',
    });
    expect(response.status).toBe(201);

    await Promise.all([ firstMessage, firstWebhook ]);
    // Leave some time for potential duplicates to arrive before counting
    await new Promise<void>((resolve): any => setTimeout(resolve, 500));
    socket.close();

    expect(socketMessages).toHaveLength(1);
    expectNotification(JSON.parse(socketMessages[0].toString()), topic, 'Create');

    expect(webhookNotifications).toHaveLength(1);
    expectNotification(webhookNotifications[0], topic, 'Create');
  });

  it('delivers changes to StreamingHTTPChannel2023 receiveFrom endpoints.', async(): Promise<void> => {
    const receiveFrom = joinUrl(baseUrl, '.notifications/StreamingHTTPChannel2023', encodeURIComponent(topic));
    const streamingResponse = await fetch(receiveFrom);
    expect(streamingResponse.status).toBe(200);
    const reader = streamingResponse.body!.getReader();

    try {
      // The topic was created in the previous test, so the initial notification is an Update
      const initialQuads = await readChunk(reader);
      expect(initialQuads.getObjects(null, RDF.terms.type, null)).toEqual([ AS.terms.Update ]);

      const response = await fetch(topic, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: 'def',
      });
      expect(response.status).toBe(205);

      const quads = await readChunk(reader);
      expect(quads.getObjects(null, RDF.terms.type, null)).toEqual([ AS.terms.Update ]);
      expect(quads.getObjects(null, AS.terms.object, null)).toEqual([ namedNode(topic) ]);
    } finally {
      reader.releaseLock();
      await streamingResponse.body!.cancel();
    }
  });
});
