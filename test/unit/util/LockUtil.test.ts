import type { AttemptSettings } from '../../../src/util/LockUtils';
import { retryFunction, setJitterTimeout } from '../../../src/util/LockUtils';
import { InternalServerError } from '../../../src/util/errors/InternalServerError';

jest.useFakeTimers();

describe('LockUtil', (): void => {
  describe('#setJitterTimout', (): void => {
    it('works without jitter.', async(): Promise<void> => {
      let result = '';
      const promise = setJitterTimeout(1000).then((): void => {
        result += 'ok';
      });
      expect(result).toHaveLength(0);
      jest.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
      expect(result).toBe('ok');
    });

    it('works with jitter.', async(): Promise<void> => {
      jest.spyOn(globalThis.Math, 'random').mockReturnValue(1);
      let elapsed = Date.now();
      const promise = setJitterTimeout(1000, 100).then((): void => {
        elapsed = Date.now() - elapsed;
      });
      jest.runAllTimers();
      await expect(promise).resolves.toBeUndefined();
      expect(elapsed).toBe(1100);
      // Clean up
      jest.spyOn(globalThis.Math, 'random').mockRestore();
    });
  });

  describe('#retryFunction', (): void => {
    const settings: Required<AttemptSettings> = {
      retryCount: 4,
      retryDelay: 100,
      retryJitter: 0,
      retryBackoffFactor: 1,
      retryDelayMax: 1000,
    };
    let timeoutSpy: jest.SpyInstance;

    beforeEach(async(): Promise<void> => {
      timeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    });

    afterEach(async(): Promise<void> => {
      timeoutSpy.mockRestore();
    });

    it('returns the value of the function immediately when it succeeds.', async(): Promise<void> => {
      const fn = jest.fn().mockResolvedValue('result');
      await expect(retryFunction(fn, settings)).resolves.toBe('result');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledTimes(0);
    });

    it('retries with a constant delay when the backoff factor is 1.', async(): Promise<void> => {
      const fn = jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce('result');
      const promise = retryFunction(fn, settings);
      await jest.runAllTimersAsync();
      await expect(promise).resolves.toBe('result');
      expect(fn).toHaveBeenCalledTimes(3);
      expect(timeoutSpy.mock.calls.map((call): number => call[1] as number)).toEqual([ 100, 100 ]);
    });

    it('increases the delay by the backoff factor up to the configured maximum.', async(): Promise<void> => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const promise = retryFunction(fn, { ...settings, retryBackoffFactor: 2, retryDelayMax: 500 });
      // Prevent the rejection from being treated as unhandled while the timers are being advanced
      promise.catch(jest.fn());
      await jest.runAllTimersAsync();
      await expect(promise).rejects.toThrow(InternalServerError);
      expect(fn).toHaveBeenCalledTimes(5);
      expect(timeoutSpy.mock.calls.map((call): number => call[1] as number)).toEqual([ 100, 200, 400, 500 ]);
    });
  });
});
