import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { ServerOptions } from 'node:https';
import { createServer as createHttpsServer } from 'node:https';
import { getLoggerFor } from '../logging/LogUtil';
import type { HttpServerFactory } from './HttpServerFactory';
import type { ServerConfigurator } from './ServerConfigurator';

/**
 * Options to be used when creating the server.
 * Due to Components.js not supporting external types, this has been simplified (for now?).
 * The common https keys here (key/cert/pfx) will be interpreted as file paths that need to be read
 * before passing the options to the `createServer` function.
 */
export interface BaseServerFactoryOptions {
  /**
   * If the server should start as an HTTP or HTTPS server.
   */
  https?: boolean;

  key?: string;
  cert?: string;

  pfx?: string;
  passphrase?: string;

  /**
   * Maximum duration, in milliseconds, the server waits to receive the entire request from the client.
   * Protects against slowloris-style attacks where a request body is sent extremely slowly.
   * When unset, the Node.js default of 300000 (5 minutes) is used.
   * A value of 60000 (1 minute) is a reasonable starting point for production deployments.
   */
  requestTimeout?: number;

  /**
   * Maximum duration, in milliseconds, the server waits to receive the complete HTTP headers from the client.
   * Protects against slowloris-style attacks where headers are sent extremely slowly.
   * When unset, the Node.js default of the minimum between 60000 (1 minute)
   * and the request timeout is used.
   * A value of 10000 (10 seconds) is a reasonable starting point for production deployments.
   */
  headersTimeout?: number;

  /**
   * Duration, in milliseconds, the server waits for additional incoming data on an idle connection
   * before closing the socket.
   * When unset, the Node.js default of 5000 (5 seconds) is used.
   * Increase this when the server runs behind a load balancer with a longer idle timeout.
   */
  keepAliveTimeout?: number;

  /**
   * Maximum number of concurrent connections the server accepts; connections above this limit are rejected.
   * When unset, Node.js does not limit the number of connections.
   * Set this based on the resources available to the server to prevent connection exhaustion.
   */
  maxConnections?: number;
}

/**
 * Creates an HTTP(S) server native Node.js `http`/`https` modules.
 *
 * Will apply a {@link ServerConfigurator} to the server,
 * which should be used to attach listeners.
 */
export class BaseServerFactory implements HttpServerFactory {
  protected readonly logger = getLoggerFor(this);

  private readonly configurator: ServerConfigurator;
  private readonly options: BaseServerFactoryOptions;

  public constructor(configurator: ServerConfigurator, options?: BaseServerFactoryOptions) {
    this.configurator = configurator;
    this.options = { https: false, ...options };
  }

  /**
   * Creates an HTTP(S) server.
   */
  public async createServer(): Promise<Server> {
    const options = this.createServerOptions();

    const server = this.options.https ? createHttpsServer(options) : createHttpServer(options);

    if (typeof this.options.requestTimeout === 'number') {
      server.requestTimeout = this.options.requestTimeout;
    }
    if (typeof this.options.headersTimeout === 'number') {
      server.headersTimeout = this.options.headersTimeout;
    }
    if (typeof this.options.keepAliveTimeout === 'number') {
      server.keepAliveTimeout = this.options.keepAliveTimeout;
    }
    if (typeof this.options.maxConnections === 'number') {
      server.maxConnections = this.options.maxConnections;
    }

    await this.configurator.handleSafe(server);

    return server;
  }

  private createServerOptions(): ServerOptions {
    const options = { ...this.options };
    for (const id of [ 'key', 'cert', 'pfx' ] as const) {
      const val = options[id];
      if (val) {
        options[id] = readFileSync(val, 'utf8');
      }
    }
    return options;
  }
}
