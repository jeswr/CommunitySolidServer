import cluster from 'node:cluster';
import EventEmitter from 'node:events';
import { cpus } from 'node:os';
import { ClusterManager } from '../../../../src';
import * as LogUtil from '../../../../src/logging/LogUtil';

jest.mock('node:cluster');
jest.mock('node:os', (): any => ({
  ...jest.requireActual('node:os'),
  cpus: jest.fn().mockImplementation((): any => [{}, {}, {}, {}, {}, {}]),
}));

describe('A ClusterManager', (): void => {
  const mockCluster = jest.requireMock('node:cluster');
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.spyOn(LogUtil, 'getLoggerFor').mockImplementation((): any => mockLogger);
  let emitter: EventEmitter;
  let mockWorker: any;

  beforeEach((): void => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    emitter = new EventEmitter();
    mockWorker = new EventEmitter() as any;
    mockWorker.process = { pid: 666 };
    Object.assign(mockCluster, {
      fork: jest.fn().mockImplementation((): any => mockWorker),
      on: jest.fn().mockImplementation(emitter.on.bind(emitter)),
      emit: jest.fn().mockImplementation(emitter.emit.bind(emitter)),
      isMaster: true,
      isWorker: false,
    });
  });

  afterEach((): void => {
    jest.useRealTimers();
  });

  it('can handle workers input as string.', (): void => {
    const cm = new ClusterManager(4);
    expect(cm.isSingleThreaded()).toBeFalsy();
  });

  it('can distinguish between ClusterModes.', (): void => {
    const cm1 = new ClusterManager(-1);
    const cm2 = new ClusterManager(0);
    const cm3 = new ClusterManager(1);
    const cm4 = new ClusterManager(2);
    expect(cm1.isSingleThreaded()).toBeFalsy();
    expect(cm2.isSingleThreaded()).toBeFalsy();
    expect(cm3.isSingleThreaded()).toBeTruthy();
    expect(cm4.isSingleThreaded()).toBeFalsy();
  });

  it('errors on invalid workers amount.', (): void => {
    expect((): ClusterManager => new ClusterManager(10)).toBeDefined();
    expect((): ClusterManager => new ClusterManager(2)).toBeDefined();
    expect((): ClusterManager => new ClusterManager(1)).toBeDefined();
    expect((): ClusterManager => new ClusterManager(0)).toBeDefined();
    expect((): ClusterManager => new ClusterManager(-1)).toBeDefined();
    expect((): ClusterManager => new ClusterManager(-5)).toBeDefined();
    expect((): ClusterManager => new ClusterManager(-6)).toThrow('Invalid workers value');
    expect((): ClusterManager => new ClusterManager(-10)).toThrow('Invalid workers value');
  });

  it('has an isPrimary() that works.', (): void => {
    const cm = new ClusterManager(-1);
    expect(cm.isPrimary()).toBeTruthy();
  });

  it('has an isWorker() that works.', (): void => {
    const cm = new ClusterManager(-1);
    expect(cm.isWorker()).toBeFalsy();
  });

  it('can autoscale to num_cpu and applies proper logging.', (): void => {
    const cm = new ClusterManager(-1);
    const workers = cpus().length - 1;
    expect(cpus()).toHaveLength(workers + 1);

    cm.spawnWorkers();

    expect(mockLogger.info).toHaveBeenCalledWith(`Setting up ${workers} workers`);

    for (let i = 0; i < workers; i++) {
      mockCluster.emit('online', mockWorker);
    }

    expect(cluster.on).toHaveBeenCalledWith('online', expect.any(Function));
    expect(cluster.on).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(cluster.fork).toHaveBeenCalledTimes(workers);
    expect(mockLogger.info).toHaveBeenLastCalledWith(`All ${workers} requested workers have been started.`);
  });

  it('can receive message from spawned workers.', (): void => {
    const cm = new ClusterManager(2);

    cm.spawnWorkers();
    const msg = 'Hi from worker!';
    mockWorker.emit('message', msg);
    expect(mockLogger.info).toHaveBeenCalledWith(msg);
  });

  it('forks a replacement worker only after the base backoff delay.', (): void => {
    const cm = new ClusterManager(2);
    cm.spawnWorkers();
    expect(cluster.fork).toHaveBeenCalledTimes(2);

    mockCluster.emit('exit', mockWorker, 333, 'SIGKILL');
    expect(mockLogger.warn).toHaveBeenCalledWith('Worker 666 died with code 333 and signal SIGKILL');
    expect(mockLogger.warn)
      .toHaveBeenCalledWith('Starting a new worker in 100 ms (restart 1 of 5 in the last 60000 ms)');
    expect(cluster.fork).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(99);
    expect(cluster.fork).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(cluster.fork).toHaveBeenCalledTimes(3);

    const msg = 'Hi from replacement worker!';
    mockWorker.emit('message', msg);
    expect(mockLogger.info).toHaveBeenCalledWith(msg);
  });

  it('doubles the refork delay for every restart within the rolling window.', (): void => {
    const cm = new ClusterManager(2);
    cm.spawnWorkers();

    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.warn)
      .toHaveBeenCalledWith('Starting a new worker in 100 ms (restart 1 of 5 in the last 60000 ms)');
    jest.advanceTimersByTime(100);
    expect(cluster.fork).toHaveBeenCalledTimes(3);

    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.warn)
      .toHaveBeenCalledWith('Starting a new worker in 200 ms (restart 2 of 5 in the last 60000 ms)');
    jest.advanceTimersByTime(199);
    expect(cluster.fork).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    expect(cluster.fork).toHaveBeenCalledTimes(4);

    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.warn)
      .toHaveBeenCalledWith('Starting a new worker in 400 ms (restart 3 of 5 in the last 60000 ms)');
    jest.advanceTimersByTime(400);
    expect(cluster.fork).toHaveBeenCalledTimes(5);
  });

  it('stops reforking and logs an error when the restart budget is exceeded.', (): void => {
    const cm = new ClusterManager(2);
    cm.spawnWorkers();

    // Spend the full restart budget of 5 restarts
    for (let i = 0; i < 5; i++) {
      mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
      jest.advanceTimersByTime(100 * (2 ** i));
    }
    expect(cluster.fork).toHaveBeenCalledTimes(7);
    expect(mockLogger.warn).toHaveBeenCalledTimes(10);
    expect(mockLogger.error).toHaveBeenCalledTimes(0);

    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Worker 666 died with code 1 and signal SIGSEGV. ' +
      'Not starting a new worker: crash loop exceeded the budget of 5 restarts in the last 60000 ms.',
    );
    expect(mockLogger.warn).toHaveBeenCalledTimes(10);

    jest.advanceTimersByTime(30_000);
    expect(cluster.fork).toHaveBeenCalledTimes(7);
  });

  it('does not refork or consume the restart budget when a worker exited after disconnect.', (): void => {
    const cm = new ClusterManager(2);
    cm.spawnWorkers();

    mockWorker.exitedAfterDisconnect = true;
    mockCluster.emit('exit', mockWorker, 0, 'SIGTERM');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Worker 666 exited intentionally with code 0 and signal SIGTERM. Not starting a new worker.',
    );
    expect(mockLogger.warn).toHaveBeenCalledTimes(0);
    jest.advanceTimersByTime(60_000);
    expect(cluster.fork).toHaveBeenCalledTimes(2);

    // An unexpected exit afterwards still starts at the base delay
    mockWorker.exitedAfterDisconnect = false;
    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.warn)
      .toHaveBeenCalledWith('Starting a new worker in 100 ms (restart 1 of 5 in the last 60000 ms)');
    jest.advanceTimersByTime(100);
    expect(cluster.fork).toHaveBeenCalledTimes(3);
  });

  it('resets the restart budget once previous restarts fall outside the rolling window.', (): void => {
    const cm = new ClusterManager(2);
    cm.spawnWorkers();

    for (let i = 0; i < 5; i++) {
      mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
      jest.advanceTimersByTime(100 * (2 ** i));
    }
    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(cluster.fork).toHaveBeenCalledTimes(7);

    // Wait until all previous restarts are outside the rolling window
    jest.advanceTimersByTime(60_000);
    mockCluster.emit('exit', mockWorker, 1, 'SIGSEGV');
    expect(mockLogger.warn)
      .toHaveBeenCalledWith('Starting a new worker in 100 ms (restart 1 of 5 in the last 60000 ms)');
    jest.advanceTimersByTime(100);
    expect(cluster.fork).toHaveBeenCalledTimes(8);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});
