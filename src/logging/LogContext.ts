import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Runs the given function within a logging context that has a newly generated request identifier.
 * Log messages emitted while the function, or any asynchronous work it starts, is running
 * will include this identifier in their metadata.
 *
 * @param fn - The function to run.
 *
 * @returns The result of calling the given function.
 */
export function runWithRequestId<T>(fn: () => T): T {
  return requestIdStorage.run(randomUUID(), fn);
}

/**
 * Returns the request identifier of the current logging context,
 * or `undefined` when called outside a {@link runWithRequestId} context.
 */
export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/**
 * Binds the given function to the request identifier of the current logging context,
 * so the identifier is not lost when the function gets called from outside that context,
 * such as an event listener invoked by an external emitter.
 * Preserves the `this` binding, matching the behavior of `AsyncLocalStorage.bind`.
 *
 * @param fn - The function to bind.
 *
 * @returns The bound function, or the original function when there is no request identifier.
 */
export function bindToCurrentRequestId<TArgs extends unknown[], TOut>(fn: (...args: TArgs) => TOut):
(...args: TArgs) => TOut {
  const requestId = requestIdStorage.getStore();
  if (typeof requestId === 'undefined') {
    return fn;
  }
  return function(this: unknown, ...args: TArgs): TOut {
    return requestIdStorage.run(requestId, (): TOut => fn.call(this, ...args));
  };
}
