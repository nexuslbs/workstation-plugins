// plugins/ssh-tools - the `ssh@1` CONSUMER.
//
// It exposes the ssh transport as the MODEL-FACING tools `ssh_run`,
// `ssh_status`, `ssh_copy_to` and `ssh_copy_from`, through the tools seam
// `ctx.tools.register(defineTool({...}))` (definitions/tools.ts). It imports the
// DEFINITION and the shared helpers only:
//
//   Provider -> Definition <- Consumer   (this file)
//
// No backend, no protocol and no CLI name appears here. Which machine answers
// and which identity authenticates is the provider's config; this plugin binds
// a per-call instance with `ctx.ssh.create({ host, privateKeyName, ... })`.
//
// PRIOR ART MAPPING (the omniagent Rust MCP plugin
// /opt/workspace/omniagent/plugins/tools/ssh/, tool names run/copy/status):
//
//   prior `ssh_run`            -> `ssh_run`       (one command string, one result)
//   prior `ssh_copy` to-remote -> `ssh_copy_to`   (local file -> remote path)
//   prior `ssh_copy` from-rem. -> `ssh_copy_from` (remote path -> local file)
//   prior `ssh_status`         -> `ssh_status`    (connectivity + latency)
//   prior `ssh_key_secret_name`-> `credential`    (a credential NAME, never a value)
//
// The prior plugin owned `scp`; `ssh@1` deliberately has ONLY `run`, so both
// copy directions are built ON that single-command seam: the file travels as
// base64 INSIDE the one remote command string (`printf %s '<b64>' | base64 -d >
// <path>` to-remote, `base64 -w0 < <path>` from-remote). That keeps the
// shell-safety invariant in one place (the provider's `planSsh`) and needs no
// new contract member.
//
// NO TARGET HOST IS INVENTED OR BAKED IN: `host` (the portable
// `[user@]host[:port]` form) is a REQUIRED tool parameter. The key is named by an
// optional `credential` parameter defaulting to the consumer config's
// `privateKeyName`; the ssh config file defaults to /opt/omni/data/ssh/config.
import fs from 'node:fs'
import path from 'node:path'
import { requireSsh, type SshConfig, type SshInstance, type SshService } from '../../definitions/ssh.ts'
import { ServiceError, messageOf, positiveInt, shellQuote, type ServiceContext } from '../../definitions/support.ts'
import {
  defineTool,
  renderValue,
  type ParameterSchemaSpec,
  type ToolDefinition,
} from '../../definitions/tools.ts'

export const name = 'ssh-tools'

/** ssh config file used when the consumer config names none. */
export const DEFAULT_CONFIG_FILE_PATH = '/opt/omni/data/ssh/config'

/** Per-call timeout when neither the config nor the call names one. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Output cap when neither the config nor the call names one (4 MiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Transfer bound for one copy, in bytes. base64 expands the payload by 4/3 and
 * the encoded text must fit in the single ssh argv element, which Linux caps at
 * MAX_ARG_STRLEN (128 KiB). 48 KiB -> 64 KiB of base64, well inside the cap;
 * a larger file is REJECTED with a structured error instead of a mangled copy.
 */
export const DEFAULT_MAX_COPY_BYTES = 48 * 1024

/** Hard cap a config may raise the transfer bound to (64 KiB -> ~85 KiB b64). */
export const MAX_COPY_BYTES = 64 * 1024

export interface Config {
  /** Credential NAME used when a tool call passes no `credential`. Never a value. */
  privateKeyName?: string
  /** ssh config file (`-F <path>`) for every call; default {@link DEFAULT_CONFIG_FILE_PATH}. */
  configFilePath?: string
  /** Default per-call timeout. */
  timeoutMs?: number
  /** Default output cap. */
  maxOutputBytes?: number
  /** Transfer bound of `ssh_copy_to` / `ssh_copy_from` (hard cap {@link MAX_COPY_BYTES}). */
  maxCopyBytes?: number
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

export interface SshToolsContext extends ServiceContext {
  tools: ToolsLike
  effect?: (callback: () => () => void) => void
}

/** The consumer config after normalisation. */
export interface Settings {
  configFilePath: string
  timeoutMs: number
  maxOutputBytes: number
  maxCopyBytes: number
  privateKeyName?: string
}

/** Normalises the consumer config; malformed values fall back to defaults. */
export function settings(config: Config = {}): Settings {
  const privateKeyName = typeof config.privateKeyName === 'string' ? config.privateKeyName.trim() : ''
  return {
    configFilePath:
      typeof config.configFilePath === 'string' && config.configFilePath.trim() !== ''
        ? config.configFilePath.trim()
        : DEFAULT_CONFIG_FILE_PATH,
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: positiveInt(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxCopyBytes: positiveInt(config.maxCopyBytes, DEFAULT_MAX_COPY_BYTES, MAX_COPY_BYTES),
    ...(privateKeyName.length === 0 ? {} : { privateKeyName }),
  }
}

/** A trimmed non-empty string, or a structured error when it is required. */
function str(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new ServiceError('invalid-input', `ssh-tools: '${field}' is required`, {
        stage: 'ssh-tools.validate',
        details: { field },
      })
    }
    return undefined
  }
  if (typeof value !== 'string') {
    throw new ServiceError('invalid-input', `ssh-tools: '${field}' must be a string`, {
      stage: 'ssh-tools.validate',
      details: { field },
    })
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A positive integer from a call parameter, or undefined. */
function int(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ServiceError('invalid-input', `ssh-tools: '${field}' must be a positive integer`, {
      stage: 'ssh-tools.validate',
      details: { field },
    })
  }
  return Math.floor(parsed)
}

/** The ssh service, or the structured `missing-service` error `requireSsh` raises. */
function sshService(ctx: ServiceContext): SshService {
  return requireSsh(ctx)
}

/** Binds ONE per-call instance from the tool parameters plus the consumer config. */
function bindInstance(
  service: SshService,
  resolved: Settings,
  params: Record<string, unknown>,
): { instance: SshInstance; host: string; credential?: string } {
  const host = str(params.host, 'host', true) as string
  const credential = str(params.credential, 'credential') ?? resolved.privateKeyName
  if (typeof service.create !== 'function') {
    throw new ServiceError(
      'unsupported-provider',
      `ssh-tools: the '${service.provider}' ssh provider exposes no create(config) instance API`,
      { stage: 'ssh-tools.bind', details: { provider: service.provider } },
    )
  }
  const bound: SshConfig = {
    host,
    configFilePath: resolved.configFilePath,
    ...(credential === undefined ? {} : { privateKeyName: credential }),
  }
  return { instance: service.create(bound), host, ...(credential === undefined ? {} : { credential }) }
}

/** The per-call timeout parameter, when present. */
function callOptions(params: Record<string, unknown>): { timeoutMs?: number } {
  const timeoutMs = int(params.timeoutMs, 'timeoutMs')
  return timeoutMs === undefined ? {} : { timeoutMs }
}

/** A regular-file stat, or a structured `invalid-input`. */
function statFile(filePath: string): fs.Stats {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (error) {
    throw new ServiceError('invalid-input', `ssh-tools: cannot read '${filePath}' (${messageOf(error)})`, {
      stage: 'ssh-tools.copy',
      details: { path: filePath },
    })
  }
  if (!stat.isFile()) {
    throw new ServiceError('invalid-input', `ssh-tools: '${filePath}' is not a regular file`, {
      stage: 'ssh-tools.copy',
      details: { path: filePath },
    })
  }
  return stat
}

/** The base64 alphabet check (a remote answer that is not base64 is malformed). */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function tools(
  config: Config = {},
  ctx: ServiceContext,
): Record<string, { description: string; parameters: ParameterSchemaSpec; handler: (params: Record<string, unknown>) => unknown | Promise<unknown> }> {
  const resolved = settings(config)

  const hostParam = {
    type: 'string' as const,
    description: 'Target host in the portable [user@]host[:port] form (required; never invented by this plugin)',
    required: true,
  }
  const credentialParam = {
    type: 'string' as const,
    description: `Credential NAME whose value is a private key (default: the consumer config's privateKeyName${resolved.privateKeyName === undefined ? '; none configured' : `, currently '${resolved.privateKeyName}'`})`,
  }
  const timeoutParam = {
    type: 'integer' as const,
    description: `Per-call timeout in ms (default ${String(resolved.timeoutMs)})`,
  }

  return {
    ssh_run: {
      description:
        'Runs ONE command string on a remote host over ssh. The string is evaluated once by the REMOTE shell; the workbench host never evaluates it. Returns stdout, stderr, the exit code (null when killed) and the duration.',
      parameters: {
        host: hostParam,
        command: { type: 'string', description: 'Command string handed to the remote shell exactly once', required: true },
        credential: credentialParam,
        timeoutMs: timeoutParam,
      },
      handler: async (params) => {
        const service = sshService(ctx)
        const { instance, host } = bindInstance(service, resolved, params)
        const command = str(params.command, 'command', true) as string
        const result = await instance.run(command, callOptions(params))
        return {
          host,
          code: result.code,
          output: result.output,
          ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
          durationMs: result.durationMs,
          ...(result.truncated === true ? { truncated: true } : {}),
        }
      },
    },

    ssh_status: {
      description:
        'Checks ssh connectivity to a remote host and reports latency. NON-throwing: a failure answers reachable=false with the raw reason instead of an error.',
      parameters: {
        host: hostParam,
        credential: credentialParam,
        timeoutMs: timeoutParam,
      },
      handler: async (params) => {
        const started = Date.now()
        const host = typeof params.host === 'string' ? params.host.trim() : undefined
        try {
          const service = sshService(ctx)
          const { instance } = bindInstance(service, resolved, params)
          const result = await instance.run('true', callOptions(params))
          return {
            ...(host === undefined ? {} : { host }),
            reachable: result.code === 0,
            code: result.code,
            durationMs: result.durationMs,
            ...(result.stderr === undefined || result.stderr.length === 0 ? {} : { stderr: result.stderr }),
          }
        } catch (error) {
          return {
            ...(host === undefined ? {} : { host }),
            reachable: false,
            reason: messageOf(error),
            ...(error instanceof ServiceError ? { error: error.code, stage: error.stage } : {}),
            durationMs: Date.now() - started,
          }
        }
      },
    },

    ssh_copy_to: {
      description:
        `Copies ONE local file to a remote path over the ssh single-command seam (base64 inside the remote command). The file must be at most ${String(resolved.maxCopyBytes)} bytes; a larger file is rejected.`,
      parameters: {
        host: hostParam,
        localPath: { type: 'string', description: 'Local source file (regular file)', required: true },
        remotePath: { type: 'string', description: 'Remote destination path', required: true },
        credential: credentialParam,
        timeoutMs: timeoutParam,
      },
      handler: async (params) => {
        const service = sshService(ctx)
        const localPath = str(params.localPath, 'localPath', true) as string
        const remotePath = str(params.remotePath, 'remotePath', true) as string
        const { instance, host } = bindInstance(service, resolved, params)
        const stat = statFile(localPath)
        if (stat.size > resolved.maxCopyBytes) {
          throw new ServiceError(
            'invalid-input',
            `ssh-tools: '${localPath}' is ${String(stat.size)} bytes, above the ${String(resolved.maxCopyBytes)}-byte transfer bound of ssh_copy_to`,
            { stage: 'ssh-tools.copy_to', details: { localPath, bytes: stat.size, maxCopyBytes: resolved.maxCopyBytes } },
          )
        }
        const bytes = fs.readFileSync(localPath)
        const encoded = bytes.toString('base64')
        // The payload rides INSIDE the one remote command; planSsh wraps this
        // whole string in `sh -c '<...>'` and the REMOTE shell evaluates it.
        const command = `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(remotePath)}`
        const result = await instance.run(command, callOptions(params))
        if (result.code !== 0) {
          throw new ServiceError(
            'non-zero-exit',
            `ssh-tools: ssh_copy_to ${localPath} -> ${host}:${remotePath} failed with exit code ${String(result.code)}`,
            {
              stage: 'ssh-tools.copy_to',
              details: { code: result.code, stderr: result.stderr ?? '', host, remotePath },
            },
          )
        }
        return {
          direction: 'to-remote',
          host,
          localPath,
          remotePath,
          bytes: bytes.byteLength,
          code: result.code,
          durationMs: result.durationMs,
        }
      },
    },

    ssh_copy_from: {
      description:
        `Copies ONE remote file to a local path over the ssh single-command seam (base64 on the remote stdout). The file must be at most ${String(resolved.maxCopyBytes)} bytes; a larger file is rejected.`,
      parameters: {
        host: hostParam,
        remotePath: { type: 'string', description: 'Remote source file', required: true },
        localPath: { type: 'string', description: 'Local destination path (parent directories are created)', required: true },
        credential: credentialParam,
        timeoutMs: timeoutParam,
      },
      handler: async (params) => {
        const service = sshService(ctx)
        const remotePath = str(params.remotePath, 'remotePath', true) as string
        const localPath = str(params.localPath, 'localPath', true) as string
        const { instance, host } = bindInstance(service, resolved, params)
        const command = `base64 -w0 < ${shellQuote(remotePath)}`
        const result = await instance.run(command, callOptions(params))
        if (result.code !== 0) {
          throw new ServiceError(
            'non-zero-exit',
            `ssh-tools: ssh_copy_from ${host}:${remotePath} -> ${localPath} failed with exit code ${String(result.code)}`,
            {
              stage: 'ssh-tools.copy_from',
              details: { code: result.code, stderr: result.stderr ?? '', host, remotePath },
            },
          )
        }
        if (result.truncated === true) {
          throw new ServiceError(
            'malformed-output',
            `ssh-tools: the remote base64 of '${remotePath}' was cut by the output cap; raise maxOutputBytes or copy a smaller file`,
            { stage: 'ssh-tools.copy_from', details: { host, remotePath } },
          )
        }
        const encoded = result.output.replace(/\s+/g, '')
        if (!BASE64.test(encoded)) {
          throw new ServiceError(
            'malformed-output',
            `ssh-tools: the remote answer for '${remotePath}' is not base64 (the remote base64 command may be missing or the path may be a directory)`,
            { stage: 'ssh-tools.copy_from', details: { host, remotePath } },
          )
        }
        const decoded = Buffer.from(encoded, 'base64')
        if (decoded.byteLength > resolved.maxCopyBytes) {
          throw new ServiceError(
            'invalid-input',
            `ssh-tools: the remote file '${remotePath}' is ${String(decoded.byteLength)} bytes, above the ${String(resolved.maxCopyBytes)}-byte transfer bound of ssh_copy_from`,
            { stage: 'ssh-tools.copy_from', details: { remotePath, bytes: decoded.byteLength, maxCopyBytes: resolved.maxCopyBytes } },
          )
        }
        fs.mkdirSync(path.dirname(localPath), { recursive: true })
        fs.writeFileSync(localPath, decoded)
        return {
          direction: 'from-remote',
          host,
          localPath,
          remotePath,
          bytes: decoded.byteLength,
          code: result.code,
          durationMs: result.durationMs,
        }
      },
    },
  }
}

export function apply(ctx: SshToolsContext, config: Config = {}): void {
  const registered = tools(config, ctx)
  const install = (): (() => void) => {
    const disposers = Object.entries(registered).map(([toolName, tool]) =>
      ctx.tools.register(
        defineTool({
          name: toolName,
          description: tool.description,
          parameters: tool.parameters,
          execute: tool.handler,
          output: { schema: {}, render: renderValue },
        }),
      ),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(install)
  else install()
}

export default { name, inject: ['tools'], apply }
