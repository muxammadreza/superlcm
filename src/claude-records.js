// Claude Code 2.1.300+ also writes each API request into the transcript: `api-request` (its parameters),
// `api-request-shape` (system prompt and tools) and `api-request-blob` (every message it sent, copied again).
// They are bookkeeping, not conversation. Read as messages, each turn would count twice and every copied tool
// call would open again after it was answered, so no summary segment could close.
export function isRequestCopy(raw) {
  let record = raw
  if (typeof raw === 'string') try { record = JSON.parse(raw) } catch { return false }
  return typeof record?.type === 'string' && /^api-request(?:-|$)/.test(record.type)
}
