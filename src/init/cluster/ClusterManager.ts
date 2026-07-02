import type { Worker } from 'node:cluster';
import cluster from 'node:cluster';
import { cpus } from 'node:os';
import { getLoggerFor } from '../../logging/LogUtil';
import { InternalServerError } from '../../util/errors/InternalServerError';

/**
 * Different cluster modes.
 */
enum ClusterMode {
  /** Scales in relation to `core_count`. */
  autoScale,
  /** Single threaded mode, no clustering */
  singleThreaded,
  /** Fixed amount of workers being forked. (limited to core_count) */
  fixed,
}

/**
 * Convert workers amount to {@link ClusterMode}
 *
 * @param workers - Amount of workers
 *
 * @returns ClusterMode enum value
 */
function toClusterMode(workers: number): ClusterMode {
  if (workers <= 0) {
    return ClusterMode.autoScale;
  }
  if (workers === 1) {
    return ClusterMode.singleThreaded;
  }
  return ClusterMode.fixed;
}

/**
 * Base delay, in milliseconds, before a replacement is forked for a worker that exited unexpectedly.
 * The actual delay doubles for every restart that already happened
 * within the last {@link WORKER_RESTART_WINDOW_MS} milliseconds.
 */
const WORKER_RESTART_BASE_DELAY_MS = 100;

/**
 * Upper bound, in milliseconds, on the exponential backoff delay between worker restarts.
 * This is a safeguard in case the other restart constants get tuned to values
 * where the doubling would otherwise grow unbounded.
 */
const WORKER_RESTART_MAX_DELAY_MS = 30_000;

/**
 * Length, in milliseconds, of the rolling window in which worker restarts are counted.
 * Restarts older than this no longer count towards {@link WORKER_RESTART_BUDGET} or the backoff delay.
 */
const WORKER_RESTART_WINDOW_MS = 60_000;

/**
 * Maximum number of worker restarts within {@link WORKER_RESTART_WINDOW_MS} milliseconds.
 * Once this budget is spent, unexpectedly exiting workers are no longer replaced,
 * so a deterministic worker crash can not degenerate into a tight fork loop.
 * The primary process keeps running; an external supervisor is expected to restart the server.
 */
const WORKER_RESTART_BUDGET = 5;

/**
 * This class is responsible for deciding how many affective workers are needed.
 * It also contains the logic for respawning workers when they are killed by the os.
 *
 * The workers values are interpreted as follows:
 * value | actual workers |
 * ------|--------------|
 * `-m` | `num_cores - m` workers _(autoscale)_ (`m < num_cores`) |
 * `-1` | `num_cores - 1` workers _(autoscale)_ |
 * `0` | `num_cores` workers _(autoscale)_ |
 * `1` | `single threaded mode` _(default)_ |
 * `n` | `n` workers |
 */
export class ClusterManager {
  private readonly logger = getLoggerFor(this);
  private readonly workers: number;
  private readonly clusterMode: ClusterMode;
  /**
   * Timestamps, in epoch milliseconds, of recent worker restarts.
   * Entries older than {@link WORKER_RESTART_WINDOW_MS} milliseconds get pruned on every unexpected worker exit.
   */
  private restartTimestamps: number[] = [];

  public constructor(workers: number) {
    const cores = cpus().length;

    if (workers <= -cores) {
      throw new InternalServerError('Invalid workers value (should be in the interval ]-num_cores, +∞).');
    }

    this.workers = toClusterMode(workers) === ClusterMode.autoScale ? cores + workers : workers;
    this.clusterMode = toClusterMode(this.workers);
  }

  /**
   * Spawn all required workers.
   */
  public spawnWorkers(): void {
    let counter = 0;
    this.logger.info(`Setting up ${this.workers} workers`);

    for (let i = 0; i < this.workers; i++) {
      cluster.fork().on('message', (msg: string): void => {
        this.logger.info(msg);
      });
    }

    cluster.on('online', (worker: Worker): void => {
      this.logger.info(`Worker ${worker.process.pid} is listening`);
      counter += 1;
      if (counter === this.workers) {
        this.logger.info(`All ${this.workers} requested workers have been started.`);
      }
    });

    cluster.on('exit', (worker: Worker, code: number, signal: string): void => {
      if (worker.exitedAfterDisconnect) {
        this.logger.info(`Worker ${worker.process.pid} exited intentionally with code ${code} and signal ${signal}. ` +
          `Not starting a new worker.`);
        return;
      }

      const now = Date.now();
      this.restartTimestamps = this.restartTimestamps
        .filter((timestamp): boolean => now - timestamp < WORKER_RESTART_WINDOW_MS);

      if (this.restartTimestamps.length >= WORKER_RESTART_BUDGET) {
        this.logger.error(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}. ` +
          `Not starting a new worker: crash loop exceeded the budget of ${WORKER_RESTART_BUDGET} restarts ` +
          `in the last ${WORKER_RESTART_WINDOW_MS} ms.`);
        return;
      }

      const delay = Math.min(
        WORKER_RESTART_BASE_DELAY_MS * 2 ** this.restartTimestamps.length,
        WORKER_RESTART_MAX_DELAY_MS,
      );
      this.restartTimestamps.push(now);
      this.logger.warn(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
      this.logger.warn(`Starting a new worker in ${delay} ms ` +
        `(restart ${this.restartTimestamps.length} of ${WORKER_RESTART_BUDGET} ` +
        `in the last ${WORKER_RESTART_WINDOW_MS} ms)`);
      // `unref` so a pending refork timer never keeps a stopping primary process alive
      setTimeout((): void => {
        cluster.fork().on('message', (msg: string): void => {
          this.logger.info(msg);
        });
      }, delay).unref();
    });
  }

  /**
   * Check whether the CSS server was booted in single threaded mode.
   *
   * @returns True is single threaded.
   */
  public isSingleThreaded(): boolean {
    return this.clusterMode === ClusterMode.singleThreaded;
  }

  /**
   * Whether the calling process is the primary process.
   *
   * @returns True if primary
   */
  public isPrimary(): boolean {
    return cluster.isPrimary;
  }

  /**
   * Whether the calling process is a worker process.
   *
   * @returns True if worker
   */
  public isWorker(): boolean {
    return cluster.isWorker;
  }
}
