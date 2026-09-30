/**
 * container-exec - the CONCERN-SERVICE consumer of the workstation equipment
 * layer (gap-analysis report E2/E4/E5/E6/E8; operator decisions B/D/E/F/M).
 *
 * One tool per configured concern image, e.g. `datasci_exec`, `office_exec`,
 * `media_exec`, `tools_exec`. Each tool runs a command string INSIDE the
 * concern's compose SERVICE through the `general-service@1` seam (`container`
 * transport -> docker-impl -> `docker compose exec -T <service> sh -c <cmd>`),
 * exactly like himalaya-impl reaches `workstation-tools` for email.
 *
 * TWO MODES (the `run` parameter):
 *   * default (run=false): exec into the RUNNING compose service named by the
 *     row (`workstation-datasci`, ...). The service must be up (profile-gated
 *     compose services start with `--profile datasci|office|media`).
 *   * run=true: `docker run --rm -i <image> sh -c <cmd>` - ON-DEMAND, the
 *     concern IMAGE is launched as a throwaway container, so a service that is
 *     not running is still usable (the browser model's on-demand half).
 * Both modes go through the SAME `container` transport; the config row names
 * the target, the transport never falls back to the host.
 *
 * TARGET PROJECT: the compose project directory the exec mode passes as
 * `--project-directory` is CONFIGURABLE - the row's `projectDir` wins, else
 * `$WORKSTATION_EXEC_PROJECT`, else the production-safe default `/opt/omni`.
 * A dev/validation deployment (omnidev, omnistable) points it at its own tree
 * so a concern exec never lands in the production project.
 *
 * NAMING: tool names are `<id>_exec` - legal model-facing names
 * (`^[a-zA-Z0-9_-]+$`), snake_case like every other tool of this repository.
 */

import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'
import { GENERAL_SERVICE, type GeneralService, type GeneralServiceConfig } from '../../definitions/general-service.ts'

export const name = 'container-exec'

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  get(serviceName: string, strict?: boolean): unknown
  effect(callback: () => () => void): void
}

/** One concern row: the compose service + the image for on-demand `run`. */
export interface ConcernConfig {
  /** Compose service name to exec into (e.g. `workstation-datasci`). */
  service: string
  /** Image for `docker run --rm` on-demand mode (e.g. `local/workstation-datasci:latest`). */
  image: string
  /** Human description of the concern (shown in the tool description). */
  description?: string
}

export interface Config {
  /** concern id -> row; each row registers one `<id>_exec` tool. */
  concerns?: Record<string, ConcernConfig>
  /** Compose project directory override (default: $WORKSTATION_EXEC_PROJECT, else `/opt/omni`). */
  projectDir?: string
}

/** The production-safe compose project dir when nothing overrides it (mirror of docker-impl). */
const DEFAULT_PROJECT_DIR = '/opt/omni'

/** Trimmed non-empty string, or the fallback (same helper as tools-typed). */
function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const concerns = (config.concerns ?? {}) as Record<string, ConcernConfig>
  const projectDir = nonEmptyString(config.projectDir, nonEmptyString(process.env.WORKSTATION_EXEC_PROJECT, DEFAULT_PROJECT_DIR))
  for (const [id, concern] of Object.entries(concerns)) {
    const service = concern.service
    const image = concern.image
    if (typeof service !== 'string' || service.length === 0) continue
    if (typeof image !== 'string' || image.length === 0) continue
    const description = typeof concern.description === 'string' ? concern.description : id

    ctx.effect(() => ctx.tools.register(defineTool({
      name: `${id}_exec`,
      description:
        `runs a command inside the '${service}' concern container (${description}) through the ` +
        `general-service container transport. Default mode execs into the RUNNING compose service; ` +
        `pass run=true to launch the concern image on demand (docker run --rm). ` +
        `Returns the raw stdout/stderr and the exit code.`,
      parameters: {
        command: { type: 'string', description: 'the shell command to run inside the concern container' },
        run: {
          type: 'boolean',
          description: 'true = docker run --rm the concern image (on demand, service not needed); false (default) = docker compose exec into the running service',
        },
      },
      execute: async (params: { command?: unknown; run?: unknown }) => {
        const command = typeof params.command === 'string' && params.command.trim().length > 0
          ? params.command.trim()
          : null
        if (command === null) {
          return { ok: false, error: 'missing-command', message: 'a non-empty `command` is required' }
        }
        const run = params.run === true
        const general = ctx.get(GENERAL_SERVICE, false) as GeneralService | undefined
        if (general === undefined) {
          return {
            ok: false,
            error: 'missing-service',
            message: `no general-service@1 provider is loaded (enable general-service-impl + the ${run ? 'docker' : 'docker-compose'} transport)`,
          }
        }
        const target: GeneralServiceConfig = run
          ? { type: 'container', params: { engine: 'docker', image } }
          : { type: 'container', params: { engine: 'docker-compose', compose: { project_dir: projectDir, service } } }
        const result = await general.call(command, target)
        return { ok: true, service, mode: run ? 'docker-run' : 'compose-exec', ...result }
      },
      output: { schema: {}, render: renderValue },
    })))
  }
}

export default { name, inject: ['tools'], apply }