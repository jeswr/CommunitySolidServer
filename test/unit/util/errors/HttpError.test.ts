import 'jest-rdf';
import { RepresentationMetadata } from '../../../../src/http/representation/RepresentationMetadata';
import { BadRequestHttpError } from '../../../../src/util/errors/BadRequestHttpError';
import { ConflictHttpError } from '../../../../src/util/errors/ConflictHttpError';
import { ForbiddenHttpError } from '../../../../src/util/errors/ForbiddenHttpError';
import { generateHttpErrorUri, HttpError } from '../../../../src/util/errors/HttpError';
import type { HttpErrorClass } from '../../../../src/util/errors/HttpError';
import { InternalServerError } from '../../../../src/util/errors/InternalServerError';
import { MethodNotAllowedHttpError } from '../../../../src/util/errors/MethodNotAllowedHttpError';
import { NotFoundHttpError } from '../../../../src/util/errors/NotFoundHttpError';
import { NotImplementedHttpError } from '../../../../src/util/errors/NotImplementedHttpError';
import { NotModifiedHttpError } from '../../../../src/util/errors/NotModifiedHttpError';
import { PayloadHttpError } from '../../../../src/util/errors/PayloadHttpError';
import { PreconditionFailedHttpError } from '../../../../src/util/errors/PreconditionFailedHttpError';
import { RangeNotSatisfiedHttpError } from '../../../../src/util/errors/RangeNotSatisfiedHttpError';
import { UnauthorizedHttpError } from '../../../../src/util/errors/UnauthorizedHttpError';
import { UnprocessableEntityHttpError } from '../../../../src/util/errors/UnprocessableEntityHttpError';
import { UnsupportedMediaTypeHttpError } from '../../../../src/util/errors/UnsupportedMediaTypeHttpError';
import { HH, HTTP, SOLID_ERROR } from '../../../../src/util/Vocabularies';

describe('HttpError', (): void => {
  const errors: [string, number, HttpErrorClass][] = [
    [ 'BadRequestHttpError', 400, BadRequestHttpError ],
    [ 'UnauthorizedHttpError', 401, UnauthorizedHttpError ],
    [ 'ForbiddenHttpError', 403, ForbiddenHttpError ],
    [ 'NotFoundHttpError', 404, NotFoundHttpError ],
    [ 'ConflictHttpError', 409, ConflictHttpError ],
    [ 'PreconditionFailedHttpError', 412, PreconditionFailedHttpError ],
    [ 'PayloadHttpError', 413, PayloadHttpError ],
    [ 'UnsupportedMediaTypeHttpError', 415, UnsupportedMediaTypeHttpError ],
    [ 'RangeNotSatisfiedHttpError', 416, RangeNotSatisfiedHttpError ],
    [ 'UnprocessableEntityHttpError', 422, UnprocessableEntityHttpError ],
    [ 'InternalServerError', 500, InternalServerError ],
    [ 'NotImplementedHttpError', 501, NotImplementedHttpError ],
  ];

  describe.each(errors)('%s', (name, statusCode, constructor): void => {
    const options = {
      cause: new Error('cause'),
      errorCode: 'E1234',
      metadata: new RepresentationMetadata(),
    };
    const instance = new constructor('my message', options);

    it(`is an instance of ${name}.`, (): void => {
      expect(constructor.isInstance(instance)).toBeTruthy();
    });

    it('has a URI.', (): void => {
      expect(constructor.uri).toEqualRdfTerm(generateHttpErrorUri(statusCode));
    });

    it(`has name ${name}.`, (): void => {
      expect(instance.name).toBe(name);
    });

    it(`has status code ${statusCode}.`, (): void => {
      expect(instance.statusCode).toBe(statusCode);
    });

    it('sets the message.', (): void => {
      expect(instance.message).toBe('my message');
    });

    it('sets the cause.', (): void => {
      expect(instance.cause).toBe(options.cause);
    });

    it('sets the error code.', (): void => {
      expect(instance.errorCode).toBe(options.errorCode);
    });

    it('defaults to an HTTP-specific error code.', (): void => {
      expect(new constructor().errorCode).toBe(`H${statusCode}`);
    });

    it('sets the metadata.', (): void => {
      expect(instance.metadata).toBe(options.metadata);
      expect(instance.metadata.get(SOLID_ERROR.terms.errorResponse)?.value)
        .toBe(`${SOLID_ERROR.namespace}H${statusCode}`);
      expect(instance.metadata.get(HTTP.terms.statusCodeNumber)?.value).toBe(`${statusCode}`);
    });
  });

  // Separate test due to different constructor
  describe('MethodNotAllowedHttpError', (): void => {
    const options = {
      cause: new Error('cause'),
      errorCode: 'E1234',
    };
    const instance = new MethodNotAllowedHttpError([ 'GET' ], 'my message', options);

    it('is valid.', async(): Promise<void> => {
      expect(new MethodNotAllowedHttpError().methods).toHaveLength(0);
      expect(MethodNotAllowedHttpError.isInstance(instance)).toBe(true);
      expect(MethodNotAllowedHttpError.uri).toEqualRdfTerm(generateHttpErrorUri(405));
      expect(instance.name).toBe('MethodNotAllowedHttpError');
      expect(instance.statusCode).toBe(405);
      expect(instance.message).toBe('my message');
      expect(instance.cause).toBe(options.cause);
      expect(instance.errorCode).toBe(options.errorCode);
      expect(new MethodNotAllowedHttpError([ 'GET' ]).errorCode).toBe(`H405`);

      expect(instance.metadata.get(SOLID_ERROR.terms.errorResponse)?.value)
        .toBe(`${SOLID_ERROR.namespace}H405`);
      expect(instance.metadata.get(HTTP.terms.statusCodeNumber)?.value).toBe('405');
      expect(instance.metadata.get(SOLID_ERROR.terms.disallowedMethod)?.value).toBe('GET');
    });
  });

  describe('NotModifiedHttpError', (): void => {
    const eTag = 'ETAG';
    const options = {
      cause: new Error('cause'),
      errorCode: 'E1234',
    };
    const instance = new NotModifiedHttpError(eTag, 'my message', options);

    it('is valid.', async(): Promise<void> => {
      expect(new NotModifiedHttpError().metadata.get(HH.terms.etag)).toBeUndefined();
      expect(NotModifiedHttpError.isInstance(instance)).toBe(true);
      expect(NotModifiedHttpError.uri).toEqualRdfTerm(generateHttpErrorUri(304));
      expect(instance.name).toBe('NotModifiedHttpError');
      expect(instance.statusCode).toBe(304);
      expect(instance.message).toBe('my message');
      expect(instance.cause).toBe(options.cause);
      expect(instance.errorCode).toBe(options.errorCode);
      expect(new NotModifiedHttpError().errorCode).toBe(`H304`);

      expect(instance.metadata.get(SOLID_ERROR.terms.errorResponse)?.value)
        .toBe(`${SOLID_ERROR.namespace}H304`);
      expect(instance.metadata.get(HTTP.terms.statusCodeNumber)?.value).toBe('304');
      expect(instance.metadata.get(HH.terms.etag)?.value).toBe(eTag);
    });
  });
});

describe('A HttpError', (): void => {
  // Exposes the private lazy metadata cache so tests can assert it is not built prematurely.
  type WithCache = { lazyMetadata?: RepresentationMetadata };

  it('builds the provided metadata eagerly during construction.', (): void => {
    const metadata = new RepresentationMetadata();
    const error = new NotFoundHttpError('message', { metadata });
    expect(error.metadata).toBe(metadata);
    expect(metadata.get(SOLID_ERROR.terms.errorResponse)?.value).toBe(`${SOLID_ERROR.namespace}H404`);
    expect(metadata.get(HTTP.terms.statusCodeNumber)?.value).toBe('404');
  });

  it('builds identical metadata lazily when none is provided.', (): void => {
    const eager = new NotFoundHttpError('message', { metadata: new RepresentationMetadata() });
    const lazy = new NotFoundHttpError('message');
    expect(lazy.metadata.quads()).toBeRdfIsomorphic(eager.metadata.quads());
    expect(lazy.metadata.get(SOLID_ERROR.terms.errorResponse)?.value).toBe(`${SOLID_ERROR.namespace}H404`);
    expect(lazy.metadata.get(HTTP.terms.statusCodeNumber)?.value).toBe('404');
  });

  it('does not build the metadata store until it is accessed.', (): void => {
    const error = new NotFoundHttpError();
    expect((error as unknown as WithCache).lazyMetadata).toBeUndefined();
    const { metadata } = error;
    expect(metadata).toBeInstanceOf(RepresentationMetadata);
    expect((error as unknown as WithCache).lazyMetadata).toBe(metadata);
    expect(error.metadata).toBe(metadata);
  });

  it('is recognised by `isInstance` without building the metadata store.', (): void => {
    const error = new NotFoundHttpError();
    expect(HttpError.isInstance(error)).toBe(true);
    expect((error as unknown as WithCache).lazyMetadata).toBeUndefined();
  });

  it('is not recognised by `isInstance` for non-HttpError values.', (): void => {
    expect(HttpError.isInstance('string')).toBe(false);
    expect(HttpError.isInstance(new Error('bad'))).toBe(false);
    expect(HttpError.isInstance({ name: 'e', message: 'm', stack: 's', statusCode: 404 })).toBe(false);
  });
});
