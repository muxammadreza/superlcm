// Optional native model selection changes only the auxiliary request. Its
// complete history still has to fit the selected model; never trim to fit.
import {abortable} from './summary-attempt.js'
export async function forkRoute(ctx, request, selection, signal) {
  if (!selection?.enabled) return {ctx, request}
  if (!selection.provider || !selection.model) throw Error('请选择后台分支的供应商和模型')
  const info = await abortable(ctx.llm.resolveModelInfo(selection.provider, selection.model, signal),signal)
  signal?.throwIfAborted()
  const window = info.context?.contextWindow
  const maxTokens = info.defaultMaxTokens ?? request.maxTokens ?? 0
  if (!Number.isSafeInteger(window) || !Number.isSafeInteger(maxTokens) || window - maxTokens < 1024) throw Error('所选后台模型缺少有效容量，原文保留')
  return {ctx, request:{...request, provider:selection.provider, model:selection.model, maxTokens}, inputBudget:window - maxTokens}
}
