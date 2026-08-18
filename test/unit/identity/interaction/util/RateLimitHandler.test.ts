import { RepresentationMetadata } from '../../../../../src/http/representation/RepresentationMetadata';
import type {
  JsonInteractionHandler,
  JsonInteractionHandlerInput,
} from '../../../../../src/identity/interaction/JsonInteractionHandler';
import type { JsonView } from '../../../../../src/identity/interaction/JsonView';
import { RateLimitHandler } from '../../../../../src/identity/interaction/util/RateLimitHandler';
import type { RateLimiter } from '../../../../../src/identity/interaction/util/RateLimiter';
import { TooManyRequestsHttpError } from '../../../../../src/util/errors/TooManyRequestsHttpError';
import { SOLID_HTTP, SOLID_META } from '../../../../../src/util/Vocabularies';

function createMetadata(ip?: string): RepresentationMetadata {
  const metadata = new RepresentationMetadata();
  if (ip) {
    metadata.add(SOLID_HTTP.terms.clientIp, ip, SOLID_META.ResponseMetadata);
  }
  return metadata;
}

describe('A RateLimitHandler', (): void => {
  let input: JsonInteractionHandlerInput;
  let source: jest.Mocked<JsonInteractionHandler & JsonView>;
  let limiter: jest.Mocked<RateLimiter>;
  let handler: RateLimitHandler;

  beforeEach(async(): Promise<void> => {
    input = {
      method: 'POST',
      target: { path: 'target' },
      json: { email: 'USER@example.com', password: 'secret' },
      metadata: createMetadata('1.2.3.4'),
    };

    source = {
      getView: jest.fn().mockResolvedValue('view'),
      canHandle: jest.fn(),
      handle: jest.fn().mockResolvedValue('result'),
      handleSafe: jest.fn(),
    };

    limiter = {
      isAllowed: jest.fn().mockReturnValue(true),
      increment: jest.fn(),
      reset: jest.fn(),
    } as unknown as jest.Mocked<RateLimiter>;

    handler = new RateLimitHandler({ source, limiter, enabled: true, resetOnSuccess: false });
  });

  it('delegates the view to the source.', async(): Promise<void> => {
    await expect(handler.getView(input)).resolves.toBe('view');
    expect(source.getView).toHaveBeenCalledTimes(1);
    expect(source.getView).toHaveBeenLastCalledWith(input);
  });

  it('delegates canHandle to the source.', async(): Promise<void> => {
    await expect(handler.canHandle(input)).resolves.toBeUndefined();
    expect(source.canHandle).toHaveBeenCalledTimes(1);
    expect(source.canHandle).toHaveBeenLastCalledWith(input);
  });

  it('passes requests through without limiting when disabled.', async(): Promise<void> => {
    handler = new RateLimitHandler({ source, limiter, enabled: false });
    await expect(handler.handle(input)).resolves.toBe('result');
    expect(limiter.isAllowed).toHaveBeenCalledTimes(0);
    expect(limiter.increment).toHaveBeenCalledTimes(0);
    expect(source.handle).toHaveBeenCalledTimes(1);
  });

  it('is enabled by default.', async(): Promise<void> => {
    handler = new RateLimitHandler({ source, limiter });
    await expect(handler.handle(input)).resolves.toBe('result');
    expect(limiter.isAllowed).toHaveBeenCalledTimes(1);
  });

  it('lets requests through and counts them when under the limit.', async(): Promise<void> => {
    await expect(handler.handle(input)).resolves.toBe('result');
    expect(limiter.isAllowed).toHaveBeenLastCalledWith('1.2.3.4:user@example.com');
    expect(source.handle).toHaveBeenCalledTimes(1);
    expect(limiter.increment).toHaveBeenCalledTimes(1);
    expect(limiter.increment).toHaveBeenLastCalledWith('1.2.3.4:user@example.com');
    expect(limiter.reset).toHaveBeenCalledTimes(0);
  });

  it('returns a 429 error without calling the source when over the limit.', async(): Promise<void> => {
    limiter.isAllowed.mockReturnValue(false);
    await expect(handler.handle(input)).rejects.toThrow(TooManyRequestsHttpError);
    expect(source.handle).toHaveBeenCalledTimes(0);
    expect(limiter.increment).toHaveBeenCalledTimes(0);
  });

  it('counts a failed attempt when the source throws.', async(): Promise<void> => {
    source.handle.mockRejectedValue(new Error('bad password'));
    await expect(handler.handle(input)).rejects.toThrow('bad password');
    expect(limiter.increment).toHaveBeenCalledTimes(1);
    expect(limiter.increment).toHaveBeenLastCalledWith('1.2.3.4:user@example.com');
    expect(limiter.reset).toHaveBeenCalledTimes(0);
  });

  it('resets the counter on success when resetOnSuccess is set.', async(): Promise<void> => {
    handler = new RateLimitHandler({ source, limiter, enabled: true, resetOnSuccess: true });
    await expect(handler.handle(input)).resolves.toBe('result');
    expect(limiter.reset).toHaveBeenCalledTimes(1);
    expect(limiter.reset).toHaveBeenLastCalledWith('1.2.3.4:user@example.com');
    expect(limiter.increment).toHaveBeenCalledTimes(0);
  });

  it('still counts failures when resetOnSuccess is set.', async(): Promise<void> => {
    handler = new RateLimitHandler({ source, limiter, enabled: true, resetOnSuccess: true });
    source.handle.mockRejectedValue(new Error('bad password'));
    await expect(handler.handle(input)).rejects.toThrow('bad password');
    expect(limiter.increment).toHaveBeenCalledTimes(1);
    expect(limiter.reset).toHaveBeenCalledTimes(0);
  });

  it('keys only on the IP when the body has no email.', async(): Promise<void> => {
    input.json = {};
    await handler.handle(input);
    expect(limiter.isAllowed).toHaveBeenLastCalledWith('1.2.3.4');
  });

  it('keys on "unknown" when no client IP is available.', async(): Promise<void> => {
    input.json = {};
    input.metadata = createMetadata();
    await handler.handle(input);
    expect(limiter.isAllowed).toHaveBeenLastCalledWith('unknown');
  });

  it('ignores a non-object body when building the key.', async(): Promise<void> => {
    input.json = 'not an object';
    await handler.handle(input);
    expect(limiter.isAllowed).toHaveBeenLastCalledWith('1.2.3.4');
  });

  it('ignores a non-string or empty email when building the key.', async(): Promise<void> => {
    input.json = { email: 42 };
    await handler.handle(input);
    expect(limiter.isAllowed).toHaveBeenLastCalledWith('1.2.3.4');

    input.json = { email: '' };
    await handler.handle(input);
    expect(limiter.isAllowed).toHaveBeenLastCalledWith('1.2.3.4');
  });
});
