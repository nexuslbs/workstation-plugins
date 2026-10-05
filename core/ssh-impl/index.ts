// core/ssh-impl - the `ssh@1` PROVIDER (`ssh-cli`): REMOTE execution.
//
// It is the ssh transport of `general-service@1` (types `ssh` and
// `ssh+container`) and the backend `plugins/ssh-tools` reaches as `ctx.ssh`.
//
// SHELL-SAFETY (definitions/ssh.ts): the input is ONE command string handed to
// the REMOTE shell exactly once. The launcher argv is
//
//   ssh <options...> -i <key> -o IdentitiesOnly=yes <target> "sh -c '<input>'"
//
// The last element is ONE argv element; the host shell is never started (the
// argv array goes straight to the OS through `execFile`, lib/process.ts - never
// `shell: true`, never a host-side `sh -c`). The remote login shell parses the
// last element and runs `sh -c <input>` there. A command whose target is
// unreachable FAILS at the transport; it never runs on the workbench host.
//
// KEY MATERIAL BY CREDENTIAL NAME: `privateKeyName` is a credential NAME, never
// a path and never a value. It is resolved at CALL time through
// `ctx.credentials.resolve({ name })` (mirroring core/email-himalaya/index.ts:193
// and core/totp-rfc6238/index.ts:465), written to a fresh 0600 temp file that
// lives for exactly ONE call, passed as `-i <path>` with `IdentitiesOnly=yes`,
// and removed in a `finally` block on EVERY return path (success, failure,
// timeout). The value is never logged, never written outside that temp dir, and
// never put in a config. A missing credential is a structured error NAMING the
// credential; there is NO fallback to an unauthenticated attempt.
//
// THE ROW CONFIG MAY HAVE NO HOST: `apply` never validates its own config, so a
// mounted row without a target still LOADS. Validation happens per call
// (`run`), where a row without `host` answers `invalid-config`. The explicit
// `create(config)` instance seam validates its config immediately, because that
// is what `general-service@1` binds before a call (`bindTransport` -> `create`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SSH,
  SSH_CONTRACT,
  planSsh,
  validateSshConfig,
  type SshConfig,
  type SshInstance,
  type SshResult,
  type SshRunOptions,
  type SshService,
} from '../../definitions/ssh.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  credentialsOf,
  messageOf,
  positiveInt,
  provideService,
  type CredentialsLike,
  type ServiceContext,
} from '../../definitions/support.ts'
import { runProcess, type ProcessOutcome } from '../../lib/process.ts'

export const name = 'ssh-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'ssh-cli'

/** Contract id including the version (`ssh@1`). */
export const contract = SSH_CONTRACT

/** The process runner this provider uses (injectable so tests need no real ssh). */
export type RunProcessLike = (
  argv: readonly string[],
  options: {
    timeoutMs: number
    maxOutputBytes: number
    stage: string
    details?: Record<string, unknown>
  },
) => Promise<ProcessOutcome>

/** Test seams: the child runner and the credential lookup are replaceable. */
export interface SshProviderDeps {
  runProcess?: RunProcessLike
  credentialsOf?: (ctx: ServiceContext) => CredentialsLike | undefined
}

/** A materialised key file and the disposer that removes its private temp dir. */
interface MaterializedKey {
  file: string
  remove: () => void
}

/**
 * Resolves `credentialName` through `ctx.credentials` and writes its VALUE to a
 * fresh 0600 temp file. The temp DIRECTORY is created with `mkdtemp` (0700), the
 * file is written 0600 and chmod'd 0600 again. Any failure removes the directory
 * before throwing a structured error that NAMES the credential and never echoes
 * the value.
 */
async function materializeKey(
  ctx: ServiceContext,
  resolveCredentials: (ctx: ServiceContext) => CredentialsLike | undefined,
  credentialName: string,
): Promise<MaterializedKey> {
  const credentials = resolveCredentials(ctx)
  if (credentials === undefined) {
    throw new ServiceError(
      'missing-service',
      `ssh: the credential '${credentialName}' cannot be resolved (no credentials capability is loaded)`,
      { stage: 'ssh.credentials', details: { credential: credentialName } },
    )
  }
  let resolution: { value?: string } | undefined
  try {
    resolution = await credentials.resolve({ name: credentialName })
  } catch (error) {
    throw new ServiceError(
      'not-configured',
      `ssh: the credential '${credentialName}' could not be resolved (${messageOf(error)})`,
      { stage: 'ssh.credentials', details: { credential: credentialName } },
    )
  }
  const value = resolution?.value
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ServiceError(
      'not-configured',
      `ssh: the credential '${credentialName}' did not resolve to a private key`,
      { stage: 'ssh.credentials', details: { credential: credentialName } },
    )
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-impl-key-'))
  try {
    const file = path.join(dir, 'id_key')
    fs.writeFileSync(file, value.endsWith('\n') ? value : `${value}\n`, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    return {
      file,
      remove: () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          /* best effort: the temp dir is 0700 and holds no other caller's data */
        }
      },
    }
  } catch (error) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    throw new ServiceError(
      'spawn-failed',
      `ssh: cannot materialise the credential '${credentialName}' (${messageOf(error)})`,
      { stage: 'ssh.credentials', details: { credential: credentialName } },
    )
  }
}

/** Runs ONE command string over ssh for an explicit config. */
async function runResolved(
  ctx: ServiceContext,
  raw: Partial<SshConfig>,
  input: string,
  options: SshRunOptions,
  resolveCredentials: (ctx: ServiceContext) => CredentialsLike | undefined,
  run: RunProcessLike,
): Promise<SshResult> {
  // Deferred on purpose: a row config without a host is legal to LOAD and fails
  // here, per call, with a structured `invalid-config`.
  const normalized = validateSshConfig(raw)
  if (typeof input !== 'string') {
    throw new ServiceError('invalid-input', 'ssh: the command input must be a string', { stage: 'ssh.run' })
  }
  const timeoutMs = positiveInt(options.timeoutMs, normalized.timeoutMs)
  const maxOutputBytes = positiveInt(options.maxOutputBytes, normalized.maxOutputBytes)

  let materialized: MaterializedKey | undefined
  try {
    let planConfig = normalized
    if (normalized.privateKeyName !== undefined) {
      materialized = await materializeKey(ctx, resolveCredentials, normalized.privateKeyName)
      // The key is named explicitly, so ssh must not fall back to another
      // identity (an agent key or a default id_*): IdentitiesOnly=yes.
      planConfig = { ...normalized, options: [...normalized.options, '-o', 'IdentitiesOnly=yes'] }
    }
    const { argv } = planSsh(planConfig, input, materialized?.file)
    const outcome = await run(argv, {
      timeoutMs,
      maxOutputBytes,
      stage: 'ssh.run',
      details: {
        transport: 'ssh',
        target: normalized.target,
        ...(normalized.port === undefined ? {} : { port: normalized.port }),
      },
    })
    return {
      output: outcome.output,
      code: outcome.code,
      ...(outcome.stderr === undefined ? {} : { stderr: outcome.stderr }),
      durationMs: outcome.durationMs,
      ...(outcome.truncated === true ? { truncated: true } : {}),
    }
  } finally {
    // The key file lives for exactly ONE call, on every path.
    materialized?.remove()
  }
}

/**
 * Builds the `ssh@1` service of provider `ssh-cli` for a config. `create` is the
 * instance seam `general-service@1` and `plugins/ssh-tools` use to bind a target
 * per call; it validates immediately (a bad target fails before any command).
 */
export function createSshService(
  config: Partial<SshConfig> = {},
  ctx: ServiceContext,
  deps: SshProviderDeps = {},
): SshService {
  const run = deps.runProcess ?? runProcess
  const resolveCredentials = deps.credentialsOf ?? credentialsOf

  const instanceFor = (bound: Partial<SshConfig>): SshInstance => {
    // Validate NOW: an instance that names an unusable target fails at creation.
    validateSshConfig(bound)
    return {
      contract: SSH_CONTRACT,
      provider: providerId,
      run: (input, options = {}) => runResolved(ctx, bound, input, options, resolveCredentials, run),
    }
  }

  return {
    contract: SSH_CONTRACT,
    provider: providerId,
    describe: () => {
      try {
        const normalized = validateSshConfig(config)
        const key =
          normalized.privateKeyName === undefined ? 'no key' : `credential '${normalized.privateKeyName}'`
        return `ssh-cli -> ${normalized.target}${normalized.port === undefined ? '' : `:${String(normalized.port)}`} (${key})`
      } catch {
        return 'not configured (the row config has no host; validation happens per call)'
      }
    },
    // Row config: validated per call, never at load.
    run: (input, options = {}) => runResolved(ctx, config, input, options, resolveCredentials, run),
    create: instanceFor,
  }
}

export function apply(ctx: ServiceContext, config: Partial<SshConfig> = {}): void {
  // This provider reaches a REMOTE machine only; the manifest must say so.
  assertPolicyDeclared(import.meta.url, { execution: 'remote', capabilities: [SSH] })
  // No validation here: a mounted row without a target must LOAD (per-call).
  provideService(ctx, SSH, createSshService(config, ctx))
}

export default { name, inject: [], apply }
