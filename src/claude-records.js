// Claude's API diagnostics contain copies of messages, not new conversation
// events. Preserve their raw bytes in the archive without replaying their content.
export function isRequestCopy(record) {
  if (typeof record === 'string') {
    try { record=JSON.parse(record) } catch { return false }
  }
  return typeof record?.type === 'string' && /^api-request(?:-|$)/.test(record.type)
}
