// Stop waiting even when a provider ignores AbortSignal. Observe late rejection
// and optionally dispose late resources, but never accept a cancelled result.
export function abortable(promise, signal, onLate) {
  if (!signal) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return false
      settled = true; signal.removeEventListener('abort', cancel); fn(value); return true
    }
    const cancel = () => finish(reject, signal.reason ?? new DOMException('Cancelled', 'AbortError'))
    signal.addEventListener('abort', cancel, {once:true})
    Promise.resolve(promise).then(value => {
      if (signal.aborted) cancel()
      if (!finish(resolve, value) && signal.aborted) {
        try { Promise.resolve(onLate?.(value)).catch(() => {}) } catch {}
      }
    }, error => finish(reject, error))
    if (signal.aborted) cancel()
  })
}

// A route timeout ends this call, not the entire background job. Callers may
// report real stream progress to renew the idle deadline; parent cancellation
// always wins. Calls that do not report progress retain the fixed deadline.
export async function summaryAttempt(run, parent, timeoutMs) {
  parent?.throwIfAborted()
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent,controller.signal]) : controller.signal
  let timer
  const progress = () => {
    if (signal.aborted) return
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(Object.assign(new DOMException('Summary request timed out', 'TimeoutError'), {summaryKind:'timeout'})), timeoutMs)
  }
  progress()
  try { return await abortable(Promise.resolve().then(() => {signal.throwIfAborted();return run(signal,progress)}), signal) }
  finally { clearTimeout(timer) }
}
