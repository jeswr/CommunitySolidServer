/**
 * Matches a version `00` W3C Trace Context `traceparent` header value of the form
 * `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`, using lowercase hexadecimal only.
 * The capture groups are, in order, the trace-id and the parent-id.
 */
const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;

/**
 * The all-zero trace-id, which the W3C Trace Context specification defines as invalid.
 */
const INVALID_TRACE_ID = '0'.repeat(32);

/**
 * The all-zero parent-id, which the W3C Trace Context specification defines as invalid.
 */
const INVALID_PARENT_ID = '0'.repeat(16);

/**
 * Extracts the trace-id from an incoming W3C Trace Context `traceparent` header value
 * so it can be reused as a log-correlation identifier,
 * allowing Community Solid Server logs to correlate with an upstream distributed trace.
 *
 * The value is validated strictly against the version `00` format;
 * anything that does not match exactly is treated as if no header was present.
 * This includes an unknown version, non-hexadecimal or wrongly sized fields,
 * and the all-zero trace-id or parent-id that the specification reserves as invalid.
 * Duplicate headers, which arrive joined with commas or (rarely) as an array of values,
 * are handled by only considering the first value.
 *
 * @param header - The raw `traceparent` header value, if any.
 *
 * @returns The 32-character lowercase hexadecimal trace-id,
 *          or `undefined` when the header is absent or invalid.
 */
export function extractTraceId(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return;
  }
  const match = TRACEPARENT_REGEX.exec(value.split(',')[0].trim());
  if (!match) {
    return;
  }
  const [ , traceId, parentId ] = match;
  if (traceId === INVALID_TRACE_ID || parentId === INVALID_PARENT_ID) {
    return;
  }
  return traceId;
}
