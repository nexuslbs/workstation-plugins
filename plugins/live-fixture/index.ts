/**
 * live-fixture - the smallest possible native dsh plugin, used as the SUBJECT
 * of the live add/remove demonstrations of `plugin-live`.
 *
 * It is deliberately NOT part of the workstation boot roster
 * (config/workstation.yml): the point is that it can be added to the RUNNING
 * service with one `plugin add` call and disposed again with one
 * `plugin remove` call, without a container recreate. Its single tool
 * (`fixture ping`) is the observable proof that the added row really mounted.
 */

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'live-fixture'

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
}

export interface Config {
  /** Marker echoed back by `fixture ping`, so a caller can tell which row answered. */
  label?: string
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const label = typeof config.label === 'string' && config.label.trim().length > 0 ? config.label.trim() : 'live-fixture'

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fixture ping',
    description: 'answers with the marker of the live-fixture plugin row; the reachability probe of a live plugin add',
    parameters: {
      message: { type: 'string', description: 'any string to echo back' },
    },
    execute: async (params) => ({
      plugin: 'live-fixture',
      label,
      pong: typeof params.message === 'string' ? params.message : null,
    }),
    output: { schema: {}, render: renderValue },
  })))
}

export default { name, inject: ['tools'], apply }
