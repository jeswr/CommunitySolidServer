import { RateLimiter } from '../../../../../src/identity/interaction/util/RateLimiter';

describe('A RateLimiter', (): void => {
  let now: number;
  let limiter: RateLimiter;

  beforeEach(async(): Promise<void> => {
    now = 1000;
    jest.spyOn(Date, 'now').mockImplementation((): number => now);
    limiter = new RateLimiter({ maxCount: 2, windowMs: 1000 });
  });

  afterEach((): void => {
    jest.restoreAllMocks();
  });

  it('allows a key that has not been used yet.', async(): Promise<void> => {
    expect(limiter.isAllowed('key')).toBe(true);
  });

  it('blocks a key once its maximum count is reached.', async(): Promise<void> => {
    limiter.increment('key');
    expect(limiter.isAllowed('key')).toBe(true);
    limiter.increment('key');
    expect(limiter.isAllowed('key')).toBe(false);
  });

  it('keeps different keys independent.', async(): Promise<void> => {
    limiter.increment('a');
    limiter.increment('a');
    expect(limiter.isAllowed('a')).toBe(false);
    expect(limiter.isAllowed('b')).toBe(true);
  });

  it('resets a key when requested.', async(): Promise<void> => {
    limiter.increment('key');
    limiter.increment('key');
    expect(limiter.isAllowed('key')).toBe(false);
    limiter.reset('key');
    expect(limiter.isAllowed('key')).toBe(true);
  });

  it('resets the count once the window has expired.', async(): Promise<void> => {
    limiter.increment('key');
    limiter.increment('key');
    expect(limiter.isAllowed('key')).toBe(false);

    now += 1001;
    expect(limiter.isAllowed('key')).toBe(true);

    // A new increment after expiry starts a fresh window.
    limiter.increment('key');
    expect(limiter.isAllowed('key')).toBe(true);
    limiter.increment('key');
    expect(limiter.isAllowed('key')).toBe(false);
  });
});
