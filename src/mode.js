// Default: summaries are written in the background. 'cli' = a run of the conversation's
// own tool; 'codex-cli' is the retired name for it and is read as 'cli'.
export function summaryMode(env = process.env) {
  const configured = env.SUPERLCM_SUMMARY_MODE || (env.SUPERLCM_SUMMARIZE_ON_HOOK === '1' ? 'api' : 'auto')
  if (!['auto', 'off', 'api', 'cli', 'codex-cli', 'agent', 'main-fork'].includes(configured)) throw new Error('SUPERLCM_SUMMARY_MODE must be auto, off, cli, main-fork, or api')
  if (configured === 'auto') return env.SUPERLCM_ANTHROPIC_API_KEY ? 'api' : 'main-fork'
  return configured === 'agent' ? 'main-fork' : configured === 'codex-cli' ? 'cli' : configured
}
