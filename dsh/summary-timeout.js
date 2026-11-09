// A native fork reads the whole request and emits every summary level at once.
// The old three-minute, single-batch deadline cut off large reasoning requests.
export const DSH_SUMMARY_TIMEOUT_MS = 600000
