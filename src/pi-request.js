import { estimateSummaryTokens } from './summary-tokens.js'

// Count native and Pi image forms as visual input, not base64 text.
export function estimatePiRequest(value) {
  let images = 0
  const text = JSON.stringify(value, (_key, item) => {
    if (['image', 'image_url', 'input_image'].includes(item?.type) || item?.inlineData?.mimeType?.startsWith('image/')) {
      images++; return { type: 'image', mimeType: item.mimeType }
    }
    return item
  })
  return estimateSummaryTokens(text || '') + images * 8192
}

export function piOutputReserve(payload, model) {
  const reserve = payload?.max_tokens ?? payload?.max_completion_tokens ?? payload?.max_output_tokens
    ?? payload?.maxOutputTokens ?? payload?.generationConfig?.maxOutputTokens ?? payload?.maxTokens
    ?? model?.maxTokens ?? Math.floor(Math.min(16384, (model?.contextWindow || 163840) * .1))
  if (!Number.isSafeInteger(reserve) || reserve < 0) throw Error('Pi 模型输出预留无效，原文保留')
  return reserve
}
