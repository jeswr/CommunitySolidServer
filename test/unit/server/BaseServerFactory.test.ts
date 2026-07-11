import type { RequestListener, Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import request from 'supertest';
import type { BaseServerFactoryOptions } from '../../../src/server/BaseServerFactory';
import { BaseServerFactory } from '../../../src/server/BaseServerFactory';
import type { ServerConfigurator } from '../../../src/server/ServerConfigurator';
import { joinFilePath } from '../../../src/util/PathUtil';
import { getPort } from '../../util/Util';

const port = getPort('BaseServerFactory');

describe('A BaseServerFactory', (): void => {
  let server: Server;

  const options: [string, BaseServerFactoryOptions | undefined][] = [
    [ 'http', undefined ],
    [ 'https', {
      https: true,
      key: joinFilePath(__dirname, '../../assets/https/server.key'),
      cert: joinFilePath(__dirname, '../../assets/https/server.cert'),
    }],
  ];

  describe.each(options)('with %s', (protocol, httpOptions): void => {
    let rejectTls: string | undefined;
    let configurator: ServerConfigurator;
    let mockRequestHandler: jest.MockedFn<RequestListener>;

    beforeAll(async(): Promise<void> => {
      // Allow self-signed certificate
      rejectTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

      mockRequestHandler = jest.fn();

      configurator = {
        async handleSafe(serv: Server): Promise<void> {
          serv.on('request', mockRequestHandler);
        },
      } as any;

      const factory = new BaseServerFactory(configurator, httpOptions);
      server = await factory.createServer();

      server.listen(port);
    });

    beforeEach(async(): Promise<void> => {
      jest.clearAllMocks();
    });

    afterAll(async(): Promise<void> => {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = rejectTls;
      server.close();
    });

    it('emits a request event on requests.', async(): Promise<void> => {
      let resolveProm: (value: unknown) => void;
      const requestProm = new Promise((resolve): void => {
        resolveProm = resolve;
      });
      server.on('request', (req, res): void => {
        resolveProm(req);
        res.writeHead(200);
        res.end();
      });
      await request(server).get('/').set('Host', 'test.com').expect(200);

      await expect(requestProm).resolves.toEqual(expect.objectContaining({
        headers: expect.objectContaining({ host: 'test.com' }),
      }));

      expect(mockRequestHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('with server tuning options', (): void => {
    let configurator: ServerConfigurator;

    beforeEach(async(): Promise<void> => {
      configurator = { handleSafe: jest.fn() } as any;
    });

    it('applies the configured timeouts and connection limit to the server.', async(): Promise<void> => {
      const factory = new BaseServerFactory(configurator, {
        requestTimeout: 60000,
        headersTimeout: 10000,
        keepAliveTimeout: 65000,
        maxConnections: 512,
      });
      const tunedServer = await factory.createServer();

      expect(tunedServer.requestTimeout).toBe(60000);
      expect(tunedServer.headersTimeout).toBe(10000);
      expect(tunedServer.keepAliveTimeout).toBe(65000);
      expect(tunedServer.maxConnections).toBe(512);
      expect(configurator.handleSafe).toHaveBeenCalledTimes(1);
      expect(configurator.handleSafe).toHaveBeenLastCalledWith(tunedServer);
    });

    it('keeps the Node.js defaults when no tuning options are defined.', async(): Promise<void> => {
      const factory = new BaseServerFactory(configurator);
      const defaultServer = await factory.createServer();
      const referenceServer = createHttpServer();

      expect(defaultServer.requestTimeout).toBe(referenceServer.requestTimeout);
      expect(defaultServer.headersTimeout).toBe(referenceServer.headersTimeout);
      expect(defaultServer.keepAliveTimeout).toBe(referenceServer.keepAliveTimeout);
      expect(defaultServer.maxConnections).toBe(referenceServer.maxConnections);
      expect(configurator.handleSafe).toHaveBeenCalledTimes(1);
    });
  });
});
