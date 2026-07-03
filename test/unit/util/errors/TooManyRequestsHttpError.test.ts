import { TooManyRequestsHttpError } from '../../../../src/util/errors/TooManyRequestsHttpError';

describe('A TooManyRequestsHttpError', (): void => {
  it('has status code 429.', async(): Promise<void> => {
    const error = new TooManyRequestsHttpError('test');

    expect(error.statusCode).toBe(429);
    expect(error.message).toBe('test');
    expect(error.name).toBe('TooManyRequestsHttpError');
  });

  it('has a default message if none was provided.', async(): Promise<void> => {
    const error = new TooManyRequestsHttpError();

    expect(error.message).toBe('Too many requests.');
  });
});
