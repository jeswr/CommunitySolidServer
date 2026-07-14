import type { AttemptSettings } from '../../../src/util/LockUtils';
import { retryFunction, setJitterTimeout } from '../../../src/util/LockUtils';

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
    const settings: Required<AttemptSettings> = { retryCount: 4, retryDelay: 100, retryJitter: 0 };

    it('returns the value when the last allowed attempt succeeds.', async(): Promise<void> => {
      const fn = jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce('result');
      const promise = retryFunction(fn, { ...settings, retryCount: 1 });
      await jest.runAllTimersAsync();
      await expect(promise).resolves.toBe('result');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('errors when the maximum amount of tries is reached without a result.', async(): Promise<void> => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const promise = retryFunction(fn, settings);
      // Prevent the rejection from being treated as unhandled while the timers are being advanced
      promise.catch(jest.fn());
      await jest.runAllTimersAsync();
      await expect(promise).rejects
        .toThrow('The operation did not succeed after the set maximum of tries (5).');
      expect(fn).toHaveBeenCalledTimes(5);
    });
  });
});
