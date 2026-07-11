/**
 * Matches a version `00` W3C Trace Context `traceparent` header value,
 * capturing the trace-id and the parent-id.
 */
const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;

// The specification reserves the all-zero trace-id and parent-id as invalid.
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_PARENT_ID = '0'.repeat(16);

/**
 * Extracts the trace-id from a W3C Trace Context `traceparent` header value
 * for reuse as a log-correlation identifier.
 * Only the first value of a duplicate header is considered,
 * and only a strictly valid version `00` value is accepted;
 * anything else, including the reserved all-zero trace-id and parent-id, is treated as no header.
 *
 * @param header - The raw `traceparent` header value, if any.
 *
 * @returns The trace-id, or `undefined` when the header is absent or invalid.
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
