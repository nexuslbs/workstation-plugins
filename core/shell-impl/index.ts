// core/shell-impl - the `shell@1` PROVIDER (`local-bash`): LOCAL execution.
//
// THIS IS THE ONLY TRANSPORT OF THIS REPOSITORY THAT RUNS A COMMAND ON THE
// WORKBENCH HOST. It says so three times, on purpose:
//   1. in its manifest (`"execution": "host"`, `policies.shell`), which
//      `apply()` verifies through `assertPolicyDeclared` - a plugin that reaches
//      host execution without declaring it does not load at all;
//   2. in its README;
//   3. in `definitions/shell.ts`, whose `planLocal` hands the input to
//      `<shell> -c <input>` on the host by design.
//
// It is the provider a `general-service@1` config of type `local` resolves to
// (and the one a consumer reaches as `ctx.shell`). It is deliberately OPT-IN: a
// deployment that never configures a local type never runs anything locally, and
// a `container`/`ssh`/`http` config never touches this service.
import {
  SHELL,
  SHELL_CONTRACT,
  validateShellConfig,
  type ShellConfig,
  type ShellInstance,
  type ShellResult,
  type ShellRunOptions,
  type ShellService,
} from '../../definitions/shell.ts'
import { assertPolicyDeclared, provideService, type ServiceContext } from '../../definitions/support.ts'
import { runProcess } from '../../lib/process.ts'

export const name = 'shell-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'local-bash'

export const contract = SHELL_CONTRACT

/** Builds the service of this provider for a validated config. */
export function createShellService(config: ShellConfig = {}): ShellService {
  const normalized = validateShellConfig(config)

  const runWith = async (input: string, options: ShellRunOptions = {}): Promise<ShellResult> => {
    const { argv } = plan(normalized.binary, input)
    const outcome = await runProcess(argv, {
      timeoutMs: options.timeoutMs ?? normalized.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? normalized.maxOutputBytes,
      ...(options.cwd ?? normalized.cwd) === undefined ? {} : { cwd: options.cwd ?? normalized.cwd },
      ...(Object.keys({ ...normalized.env, ...(options.env ?? {}) }).length === 0
        ? {}
        : { env: { ...normalized.env, ...(options.env ?? {}) } }),
      stage: 'shell.run',
      details: { transport: 'local', binary: normalized.binary },
    })
    return { output: outcome.output, code: outcome.code, stderr: outcome.stderr, durationMs: outcome.durationMs, ...(outcome.truncated === true ? { truncated: true } : {}) }
  }

  const create = (raw: ShellConfig = {}): ShellInstance => {
    const child = validateShellConfig(raw)
    return {
      contract: SHELL_CONTRACT,
      provider: providerId,
      run: (input, options) => {
        const { argv } = plan(child.binary, input)
        return runProcess(argv, {
          timeoutMs: options?.timeoutMs ?? child.timeoutMs,
          maxOutputBytes: options?.maxOutputBytes ?? child.maxOutputBytes,
          ...(options?.cwd ?? child.cwd) === undefined ? {} : { cwd: options?.cwd ?? child.cwd },
          ...(Object.keys({ ...child.env, ...(options?.env ?? {}) }).length === 0
            ? {}
            : { env: { ...child.env, ...(options?.env ?? {}) } }),
          stage: 'shell.run',
          details: { transport: 'local', binary: child.binary },
        }).then((outcome) => ({
          output: outcome.output,
          code: outcome.code,
          stderr: outcome.stderr,
          durationMs: outcome.durationMs,
          ...(outcome.truncated === true ? { truncated: true } : {}),
        }))
      },
    }
  }

  return {
    contract: SHELL_CONTRACT,
    provider: providerId,
    describe: () => `local shell ${normalized.binary}`,
    run: runWith,
    create,
  }
}

/** The launcher argv of a local command: `<binary> -c <input>` (host shell, by design). */
function plan(binary: string, input: string): { argv: string[] } {
  return { argv: [binary, '-c', input] }
}

export function apply(ctx: ServiceContext, config: ShellConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [SHELL] })
  const service = createShellService(config)
  provideService(ctx, SHELL, service)
}

export default { name, inject: [], apply }
