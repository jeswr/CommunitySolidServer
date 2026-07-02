import { PassThrough } from 'node:stream';
import type { Logger } from 'winston';
import type * as Transport from 'winston-transport';
import { WinstonLogger } from '../../../src/logging/WinstonLogger';
import { WinstonLoggerFactory } from '../../../src/logging/WinstonLoggerFactory';

const now = new Date();
jest.useFakeTimers();
jest.setSystemTime(now);

describe('WinstonLoggerFactory', (): void => {
  let factory: WinstonLoggerFactory;
  let transport: jest.Mocked<Transport>;

  beforeEach(async(): Promise<void> => {
    factory = new WinstonLoggerFactory('debug');

    // Create a dummy log transport
    transport = new PassThrough({ objectMode: true }) as any;
    jest.spyOn(transport, 'write').mockImplementation();
    // eslint-disable-next-line jest/prefer-spy-on
    transport.log = jest.fn();
  });

  it('creates WinstonLoggers.', async(): Promise<void> => {
    const logger = factory.createLogger('MyLabel');
    expect(logger).toBeInstanceOf(WinstonLogger);
    const innerLogger: Logger = (logger as any).logger;
    expect(innerLogger.level).toBe('debug');
    expect(innerLogger.format).toBeTruthy();
    expect(innerLogger.transports).toHaveLength(1);
  });

  it('allows WinstonLoggers to be invoked.', async(): Promise<void> => {
    (factory as any).createTransports = (): any => [ transport ];

    // Create logger, and log
    const logger = factory.createLogger('MyLabel');
    logger.log('debug', 'my message');

    expect(transport.write).toHaveBeenCalledTimes(1);
    // Need to check level like this as it has color tags
    const { level } = transport.write.mock.calls[0][0];
    expect(transport.write).toHaveBeenCalledWith({
      label: 'MyLabel',
      level,
      message: 'my message',
      timestamp: now.toISOString(),
      metadata: {},
      [Symbol.for('level')]: 'debug',
      [Symbol.for('splat')]: [ undefined ],
      [Symbol.for('message')]: `${now.toISOString()} [MyLabel] {W-???} ${level}: my message`,
    });
  });

  it('allows extra metadata when logging to indicate the thread.', async(): Promise<void> => {
    (factory as any).createTransports = (): any => [ transport ];

    // Create logger, and log
    const logger = factory.createLogger('MyLabel');
    logger.log('debug', 'my message', { isPrimary: true, pid: 0 });

    expect(transport.write).toHaveBeenCalledTimes(1);
    // Need to check level like this as it has color tags
    const { level } = transport.write.mock.calls[0][0];
    expect(transport.write).toHaveBeenCalledWith(expect.objectContaining({
      label: 'MyLabel',
      level,
      message: 'my message',
      timestamp: now.toISOString(),
      metadata: { isPrimary: true, pid: 0 },
      [Symbol.for('level')]: 'debug',
      [Symbol.for('splat')]: [{ isPrimary: true, pid: 0 }],
      [Symbol.for('message')]: `${now.toISOString()} [MyLabel] {Primary} ${level}: my message`,
    }));
  });

  it('errors on unknown log formats.', async(): Promise<void> => {
    expect((): WinstonLoggerFactory => new WinstonLoggerFactory('debug', 'unknown'))
      .toThrow('Unknown log format unknown, expected one of pretty/json');
  });

  it('can be created with an explicit pretty format.', async(): Promise<void> => {
    factory = new WinstonLoggerFactory('debug', 'pretty');
    (factory as any).createTransports = (): any => [ transport ];

    // Create logger, and log
    const logger = factory.createLogger('MyLabel');
    logger.log('debug', 'my message');

    expect(transport.write).toHaveBeenCalledTimes(1);
    // Need to check level like this as it has color tags
    const { level } = transport.write.mock.calls[0][0];
    expect(transport.write.mock.calls[0][0][Symbol.for('message')])
      .toBe(`${now.toISOString()} [MyLabel] {W-???} ${level}: my message`);
  });

  it('adds the request identifier to the output when there is one.', async(): Promise<void> => {
    (factory as any).createTransports = (): any => [ transport ];

    // Create logger, and log
    const logger = factory.createLogger('MyLabel');
    logger.log('debug', 'my message', { isPrimary: true, pid: 0, requestId: '4c079dca' });

    expect(transport.write).toHaveBeenCalledTimes(1);
    // Need to check level like this as it has color tags
    const { level } = transport.write.mock.calls[0][0];
    expect(transport.write.mock.calls[0][0][Symbol.for('message')])
      .toBe(`${now.toISOString()} [MyLabel] {Primary} [4c079dca] ${level}: my message`);
  });

  it('outputs a line of JSON per message when using the json format.', async(): Promise<void> => {
    factory = new WinstonLoggerFactory('debug', 'json');
    (factory as any).createTransports = (): any => [ transport ];

    // Create logger, and log
    const logger = factory.createLogger('MyLabel');
    logger.log('debug', 'my message');

    expect(transport.write).toHaveBeenCalledTimes(1);
    const line: string = transport.write.mock.calls[0][0][Symbol.for('message')];
    // The JSON format does not apply any color tags
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/\u001B/u);
    expect(JSON.parse(line)).toEqual({
      label: 'MyLabel',
      level: 'debug',
      message: 'my message',
      timestamp: now.toISOString(),
    });
  });

  it('includes the extra metadata in the JSON output.', async(): Promise<void> => {
    factory = new WinstonLoggerFactory('debug', 'json');
    (factory as any).createTransports = (): any => [ transport ];

    // Create logger, and log
    const logger = factory.createLogger('MyLabel');
    logger.log('debug', 'my message', { isPrimary: true, pid: 0, requestId: '4c079dca' });

    expect(transport.write).toHaveBeenCalledTimes(1);
    const line: string = transport.write.mock.calls[0][0][Symbol.for('message')];
    expect(JSON.parse(line)).toEqual({
      label: 'MyLabel',
      level: 'debug',
      message: 'my message',
      timestamp: now.toISOString(),
      isPrimary: true,
      pid: 0,
      requestId: '4c079dca',
    });
  });
});
