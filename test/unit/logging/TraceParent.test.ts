import { extractTraceId } from '../../../src/logging/TraceParent';

describe('extractTraceId', (): void => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const parentId = 'b7ad6b7169203331';
  const valid = `00-${traceId}-${parentId}-01`;

  it('returns undefined when the header is absent.', (): void => {
    expect(extractTraceId(undefined)).toBeUndefined();
  });

  it('returns the trace-id of a valid traceparent header.', (): void => {
    expect(extractTraceId(valid)).toBe(traceId);
  });

  it('returns the trace-id regardless of the trace flags.', (): void => {
    expect(extractTraceId(`00-${traceId}-${parentId}-00`)).toBe(traceId);
  });

  it('uses the first value of a comma-separated header.', (): void => {
    expect(extractTraceId(`${valid}, 00-11111111111111111111111111111111-2222222222222222-01`)).toBe(traceId);
  });

  it('uses the first value of an array-valued header.', (): void => {
    expect(extractTraceId([ valid, 'garbage' ])).toBe(traceId);
  });

  it('ignores a header with an unsupported version.', (): void => {
    expect(extractTraceId(`ff-${traceId}-${parentId}-01`)).toBeUndefined();
  });

  it('ignores a header with a non-hexadecimal trace-id.', (): void => {
    expect(extractTraceId(`00-0af7651916cd43dd8448eb211c80319g-${parentId}-01`)).toBeUndefined();
  });

  it('ignores a header with a wrongly sized trace-id.', (): void => {
    expect(extractTraceId(`00-0af765-${parentId}-01`)).toBeUndefined();
  });

  it('ignores a header with uppercase hexadecimal.', (): void => {
    expect(extractTraceId(`00-0AF7651916CD43DD8448EB211C80319C-${parentId}-01`)).toBeUndefined();
  });

  it('ignores a header with trailing data.', (): void => {
    expect(extractTraceId(`${valid}-extra`)).toBeUndefined();
  });

  it('ignores an all-zero trace-id.', (): void => {
    expect(extractTraceId(`00-00000000000000000000000000000000-${parentId}-01`)).toBeUndefined();
  });

  it('ignores an all-zero parent-id.', (): void => {
    expect(extractTraceId(`00-${traceId}-0000000000000000-01`)).toBeUndefined();
  });

  it('ignores an empty header value.', (): void => {
    expect(extractTraceId('')).toBeUndefined();
  });
});
