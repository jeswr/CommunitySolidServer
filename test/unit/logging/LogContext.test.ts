import { bindToCurrentRequestId, getRequestId, runWithRequestId } from '../../../src/logging/LogContext';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe('LogContext', (): void => {
  describe('#getRequestId', (): void => {
    it('returns undefined outside a request context.', async(): Promise<void> => {
      expect(getRequestId()).toBeUndefined();
    });

    it('returns the generated identifier within a request context.', async(): Promise<void> => {
      runWithRequestId((): void => {
        expect(getRequestId()).toMatch(uuidRegex);
      });
    });
  });

  describe('#runWithRequestId', (): void => {
    it('returns the result of the given function.', async(): Promise<void> => {
      expect(runWithRequestId((): number => 5)).toBe(5);
    });

    it('generates a new identifier for every context.', async(): Promise<void> => {
      const requestId = runWithRequestId((): string | undefined => getRequestId());
      const requestId2 = runWithRequestId((): string | undefined => getRequestId());
      expect(requestId).toMatch(uuidRegex);
      expect(requestId2).toMatch(uuidRegex);
      expect(requestId).not.toBe(requestId2);
    });

    it('uses the provided identifier when one is given.', async(): Promise<void> => {
      const requestId = runWithRequestId((): string | undefined => getRequestId(), 'seeded-id');
      expect(requestId).toBe('seeded-id');
    });

    it('retains the identifier across asynchronous calls.', async(): Promise<void> => {
      await runWithRequestId(async(): Promise<void> => {
        const requestId = getRequestId();
        await new Promise<void>((resolve): void => {
          setImmediate(resolve);
        });
        expect(getRequestId()).toBe(requestId);
      });
      expect(getRequestId()).toBeUndefined();
    });
  });

  describe('#bindToCurrentRequestId', (): void => {
    it('returns the input function when there is no request context.', async(): Promise<void> => {
      const fn = jest.fn();
      expect(bindToCurrentRequestId(fn)).toBe(fn);
      expect(fn).toHaveBeenCalledTimes(0);
    });

    it('restores the request identifier when the function is called outside the context.', async(): Promise<void> => {
      const fn = jest.fn((input: string): string => `${input}:${getRequestId()}`);
      let bound: (input: string) => string;
      const requestId = runWithRequestId((): string | undefined => {
        bound = bindToCurrentRequestId(fn);
        return getRequestId();
      });
      expect(getRequestId()).toBeUndefined();
      expect(bound!('result')).toBe(`result:${requestId}`);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenLastCalledWith('result');
      expect(getRequestId()).toBeUndefined();
    });

    it('preserves the this binding of the bound function.', async(): Promise<void> => {
      let captured: string | undefined;
      const object = {
        id: 'myId',
        capture(this: { id: string }): void {
          captured = `${this.id}:${getRequestId()}`;
        },
      };
      const requestId = runWithRequestId((): string | undefined => {
        // eslint-disable-next-line jest/unbound-method
        object.capture = bindToCurrentRequestId(object.capture);
        return getRequestId();
      });
      object.capture();
      expect(captured).toBe(`myId:${requestId}`);
    });
  });
});
