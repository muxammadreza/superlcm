// A shared preference; complete turns/tool groups can exceed the target.
export const defaultRecentKeep = 40000
export function recentKeep(value = defaultRecentKeep) {
  if (!Number.isSafeInteger(value) || value < 5000 || value > 200000) throw Error('最近原文保留量必须在 5K 到 200K 之间')
  return value
}
export const cappedRecentKeep = (value, activeTokens) => Math.min(recentKeep(value), Math.max(0, Math.floor(activeTokens / 2)))
