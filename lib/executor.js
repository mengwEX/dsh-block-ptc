/** Block guidance over the supported native PTC executor; no execution reimplementation. */
import { Config, inject, PtcExecutor } from '@deepseek-ai/dsh-tool-executor-ptc'
import { createBlockExecutor } from './prompts.js'

export { Config, inject }
export const name = 'block-ptc-executor'

export function apply(ctx, config) {
  ctx.tools.setExecutor(createBlockExecutor(new PtcExecutor(ctx, config)))
}
