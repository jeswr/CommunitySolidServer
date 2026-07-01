import { getLoggerFor } from '../logging/LogUtil';
import { InternalServerError } from './errors/InternalServerError';

const logger = getLoggerFor('LockUtil');

/**
 * Waits a set amount of time, without consuming cpu, with a set amount of jitter.
 *
 * @param delay - How long to wait.
 * @param jitter - A fraction of this jitter will be added to the delay.
 *
 * @returns A promise that resolves after the specified amount of time.
 */
export async function setJitterTimeout(delay: number, jitter = 0): Promise<void> {
  jitter = Math.max(0, Math.floor(Math.random() * jitter));
  delay = Math.max(0, delay + jitter);
  return new Promise<void>((resolve): unknown => setTimeout(resolve, delay));
}

export interface AttemptSettings {
  /** How many times should an operation be retried. (-1 is indefinitely). */
  retryCount?: number;
  /** The how long should the next retry be delayed (+ some retryJitter) (in ms). */
  retryDelay?: number;
  /** Add a fraction of jitter to the original delay each attempt (in ms). */
  retryJitter?: number;
  /** The factor by which the delay gets multiplied after every attempt. 1 keeps the delay constant. */
  retryBackoffFactor?: number;
  /** The upper bound for the delay between attempts (in ms), used when `retryBackoffFactor` is larger than 1. */
  retryDelayMax?: number;
}

/**
 * Will execute the given function until one of the following cases occurs:
 * * The function resolves to a value: the value is returned.
 * * The function errors: the rejected error is thrown.
 * * The function did not resolve after the set amount of retries: the rejected error is returned.
 *
 * @param fn - The function to retry. **This function must return a value!**
 * @param settings - The options on how to retry the function
 */
export async function retryFunction<T>(fn: () => Promise<T>, settings: Required<AttemptSettings>): Promise<T> {
  const { retryCount, retryDelay, retryJitter, retryBackoffFactor, retryDelayMax } = settings;
  const maxTries = retryCount === -1 ? Number.POSITIVE_INFINITY : retryCount + 1;
  let tries = 1;
  let delay = retryDelay;
  let result = await fn();

  while (typeof result === 'undefined' && tries < maxTries) {
    await setJitterTimeout(delay, retryJitter);
    delay = Math.min(delay * retryBackoffFactor, retryDelayMax);
    result = await fn();
    tries += 1;
  }

  // Max tries was reached without a result
  if (typeof result === 'undefined') {
    const err = `The operation did not succeed after the set maximum of tries (${maxTries}).`;
    logger.warn(err);
    throw new InternalServerError(err);
  }

  return result;
}
