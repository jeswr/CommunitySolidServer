import type { HttpRequest } from '../../../src/server/HttpRequest';
import { limitBodySize } from '../../../src/util/BodySizeUtil';
import { PayloadHttpError } from '../../../src/util/errors/PayloadHttpError';
import { guardedStreamFrom, readableToString } from '../../../src/util/StreamUtil';

describe('BodySizeUtil', (): void => {
  describe('#limitBodySize', (): void => {
    let request: HttpRequest;

    beforeEach(async(): Promise<void> => {
      request = guardedStreamFrom([ '0123456789' ]) as HttpRequest;
      request.headers = {};
    });

    it('returns the request unchanged if there is no limit.', async(): Promise<void> => {
      expect(limitBodySize(request)).toBe(request);
      await expect(readableToString(request)).resolves.toBe('0123456789');
    });

    it('errors before reading the body if the Content-Length header exceeds the limit.', async(): Promise<void> => {
      request.headers['content-length'] = '11';
      expect((): unknown => limitBodySize(request, 10)).toThrow(PayloadHttpError);
      expect((): unknown => limitBodySize(request, 10))
        .toThrow('The Content-Length header of 11 exceeds the maximum allowed body size of 10 bytes.');
    });

    it('supports bodies that are exactly the maximum allowed size.', async(): Promise<void> => {
      request.headers['content-length'] = '10';
      await expect(readableToString(limitBodySize(request, 10))).resolves.toBe('0123456789');
    });

    it('errors once more data than allowed has been read.', async(): Promise<void> => {
      request = guardedStreamFrom([ '0123456789', 'more data' ]) as HttpRequest;
      request.headers = {};
      const result = readableToString(limitBodySize(request, 10));
      await expect(result).rejects.toThrow(PayloadHttpError);
      await expect(result).rejects.toThrow('The body exceeds the maximum allowed body size of 10 bytes.');
    });

    it('ignores invalid Content-Length values.', async(): Promise<void> => {
      request.headers['content-length'] = 'invalid';
      await expect(readableToString(limitBodySize(request, 5))).rejects.toThrow(PayloadHttpError);
    });
  });
});
