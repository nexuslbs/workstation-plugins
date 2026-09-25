// lib/process.ts - the ONE process runner every transport provider uses.
//
// It exists so the shell-safety invariant is implemented ONCE: `execFile` takes
// an ARGV ARRAY, so the OS starts the launcher directly - there is no host
// shell, no word splitting, no globbing and no expansion of the caller's string
// on the workbench host. The only place a caller-supplied string is evaluated is
// the TARGET shell, which the transport argv names explicitly
// (`sh -c <input>` inside the container / on the remote machine).
//
// Bounds: every call carries a timeout (the process is KILLED on expiry, with
// SIGKILL) and an output cap; the result carries `truncated` when the cap cut it.
// A spawn failure and a timeout are STRUCTURED errors (`ServiceError`); a
// completed process is RETURNED with its exit code whatever that code is, so a
// caller can inspect stdout/stderr (the general service turns a non-zero code
// into the structured `non-zero-exit` error, details included).
import { execFile } from 'node:child_process'
import { ServiceError, capText, type CommandResult } from '../definitions/support.ts'

export interface RunProcessOptions {
  /** Per-call timeout in ms; the process is killed on expiry. */
  timeoutMs: number
  /** Output cap in bytes (applied to stdout and stderr separately). */
  maxOutputBytes: number
  cwd?: string
  /** Extra environment for the child (never logged). */
  env?: Record<string, string>
  /** Stage label used in structured errors, e.g. `shell.run`. */
  stage: string
  /** Structured details attached to errors (never a credential value). */
  details?: Record<string, unknown>
}

/** The stdout/stderr of a finished process plus its exit information. */
export interface ProcessOutcome extends CommandResult {
  /** True when the process was killed after its timeout. */
  timedOut: boolean
}

/**
 * Runs `argv` without a host shell and returns its outcome. Throws
 * `spawn-failed` when the launcher cannot be started (missing binary) and
 * `timeout` when it outlived its bound; a non-zero exit code is RETURNED.
 */
export function runProcess(argv: readonly string[], options: RunProcessOptions): Promise<ProcessOutcome> {
  const [command, ...args] = argv
  if (command === undefined || command.length === 0) {
    return Promise.reject(new ServiceError('spawn-failed', 'the launcher argv is empty', { stage: options.stage }))
  }
  const started = Date.now()
  return new Promise<ProcessOutcome>((resolve, reject) => {
    let timedOut = false
    const child = execFile(
      command,
      args as string[],
      {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        encoding: 'utf8',
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        // The real cap is applied below; this only stops the child from filling
        // the pipe buffers of a runaway command.
        maxBuffer: Math.max(options.maxOutputBytes * 2, 1024 * 1024),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started
        const raw = error as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null
        if (raw !== null && raw.killed === true && raw.signal === 'SIGKILL') timedOut = true
        const out = capText(String(stdout ?? ''), options.maxOutputBytes)
        const err = capText(String(stderr ?? ''), options.maxOutputBytes)
        const truncated = out.truncated || err.truncated || raw?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        const exitCode = timedOut ? null : typeof raw?.code === 'number' ? raw.code : raw === null ? 0 : 1

        if (timedOut) {
          reject(
            new ServiceError('timeout', `the command exceeded its ${options.timeoutMs}ms timeout and was killed`, {
              stage: options.stage,
              details: { command, timeoutMs: options.timeoutMs, output: out.text, stderr: err.text, ...options.details },
            }),
          )
          return
        }
        if (raw !== null && (raw.code === 'ENOENT' || raw.code === 'EACCES' || raw.code === 'ENOTDIR')) {
          reject(
            new ServiceError('spawn-failed', `cannot start '${command}': ${raw.message}`, {
              stage: options.stage,
              details: { command, code: String(raw.code), ...options.details },
            }),
          )
          return
        }
        if (raw !== null && raw.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            output: out.text,
            code: exitCode,
            stderr: err.text,
            durationMs,
            truncated: true,
            timedOut: false,
          })
          return
        }
        resolve({
          output: out.text,
          code: exitCode,
          stderr: err.text,
          durationMs,
          ...(truncated ? { truncated: true } : {}),
          timedOut: false,
        })
      },
    )
    child.on('error', (error) => {
      reject(
        new ServiceError('spawn-failed', `cannot start '${command}': ${error.message}`, {
          stage: options.stage,
          details: { command, ...options.details },
        }),
      )
    })
  })
}

// ---------------------------------------------------------------------------
// The MANAGED process runner (used by the `subprocess@1` and `jobs@1`
// providers of this repository).
//
// `runProcess` above is the transport runner: it goes through `execFile`, keeps
// the whole output in memory and has no process GROUPS. The runner below is the
// one a capability that owns a process tree needs:
//
//   * the child is started DETACHED, i.e. as the leader of its OWN process
//     group, so `killProcessGroup(pid)` reaches every descendant - a `sh -c
//     "sleep 30 & wait"` does not leave the `sleep` behind when the deadline
//     expires;
//   * stdout/stderr are STREAMED: the caller may observe chunks live, the
//     INLINE text is capped, and the bytes beyond the cap are still kept in a
//     second (bounded) buffer so a spill@1 provider can persist them instead of
//     losing them;
//   * termination is SIGNAL-ESCALATING: SIGTERM, then SIGKILL after a grace,
//     always applied to the whole group.
//
// The DSH shape this follows (`packages/subprocess`: argv + cwd + explicit env +
// deadline + termination grace + "terminate the full managed process range") is
// documented in THIRD_PARTY.md (MIT).
import { spawn, type ChildProcess } from 'node:child_process'

/** Kills the whole process GROUP led by `pid`; returns false when it is gone. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    try {
      // The group is already gone (or `pid` never became a group leader): fall
      // back to the bare pid so a caller still kills the process it knows.
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }
}

/** True when the process (or group leader) is still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** How a managed process is started. */
export interface SpawnManagedOptions {
  cwd?: string
  /** Extra environment for the child (merged over `process.env`; never logged). */
  env?: Record<string, string>
  /** Extra environment entries resolved by the caller (kept for tests/redaction). */
  stage?: string
}

/**
 * Starts `argv` as the leader of its own process group with piped stdio. The
 * argv is passed to the OS DIRECTLY: there is no host shell, no word splitting,
 * no globbing and no expansion, whatever the caller's strings contain.
 */
export function spawnManagedProcess(argv: readonly string[], options: SpawnManagedOptions = {}): ChildProcess {
  const [command, ...args] = argv
  if (command === undefined || command.length === 0) {
    throw new ServiceError('spawn-failed', 'the launcher argv is empty', { stage: options.stage ?? 'process.spawn' })
  }
  return spawn(command, args as string[], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    // OWN PROCESS GROUP: `killProcessGroup(pid)` reaches every descendant, and
    // the child is not killed by a signal sent to the workbench process group.
    detached: true,
    windowsHide: true,
  })
}

/** One live output event handed to the caller's streaming callback. */
export interface OutputChunk {
  stream: 'stdout' | 'stderr'
  text: string
  bytes: number
  totalBytes: number
}

export interface RunManagedOptions extends SpawnManagedOptions {
  /** Deadline in ms; on expiry the group gets SIGTERM, then SIGKILL (see `killGraceMs`). */
  timeoutMs: number
  /** Grace in ms between SIGTERM and SIGKILL once the deadline expires (default 0). */
  killGraceMs?: number
  /** Inline byte cap, applied to stdout and stderr separately. */
  maxOutputBytes: number
  /**
   * Bytes kept BEYOND the cap so the overflow can be spilled (default = cap).
   * The runner keeps the first `maxOutputBytes + overflowBytes` bytes of each
   * stream, however many chunks it arrives in.
   */
  overflowBytes?: number
  /** Text written to the child's stdin, which is then closed. */
  stdin?: string
  /** Live sink for stdout bytes (bounded chunks). */
  onStdout?: (chunk: OutputChunk) => void
  /** Live sink for stderr bytes. */
  onStderr?: (chunk: OutputChunk) => void
}

/** The outcome of a managed process (a non-zero exit is a normal answer). */
export interface ManagedRunOutcome {
  /** Process id of the group leader (valid after the call returns: it is gone). */
  pid: number
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  /**
   * The bytes beyond the inline cap, kept so a caller can spill the FULL output
   * instead of losing it: the first `hardCap` bytes of the stream (inline prefix
   * INCLUDED), so the spill payload is the unbroken head of the stream whatever
   * the chunk boundaries were. Absent when nothing was cut.
   */
  overflow: { stdout?: string; stderr?: string }
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  /** True when the deadline expired and the group was killed. */
  timedOut: boolean
  /** True when the process was killed (deadline or an explicit stop). */
  killed: boolean
  /** True when the inline text was cut by the cap. */
  truncated: boolean
}

/** A bounded accumulating buffer: the inline half and the overflow half. */
interface CappedStream {
  inline: string
  tail: string
  totalBytes: number
  cut: boolean
}

function pushChunk(target: CappedStream, text: string, inlineCap: number, hardCap: number): void {
  target.totalBytes += Buffer.byteLength(text, 'utf8')
  if (target.cut) {
    // Already past the inline cap: EXTEND the kept prefix up to `hardCap` bytes.
    // Without this a long stream that arrives in MANY chunks would keep only the
    // window of its LAST chunk (a spilled payload that silently loses most of the
    // output); bytes beyond `hardCap` are still counted in `totalBytes`.
    const kept = Buffer.byteLength(target.tail, 'utf8')
    if (kept >= hardCap) return
    const buffer = Buffer.from(text, 'utf8')
    const room = hardCap - kept
    target.tail += (buffer.byteLength <= room ? buffer : buffer.subarray(0, room)).toString('utf8')
    return
  }
  const combined = target.inline + text
  const buffer = Buffer.from(combined, 'utf8')
  if (buffer.byteLength <= inlineCap) {
    target.inline = combined
    return
  }
  target.cut = true
  target.inline = buffer.subarray(0, inlineCap).toString('utf8')
  const hard = buffer.subarray(0, hardCap)
  target.tail = hard.toString('utf8')
}

/**
 * Runs `argv` with a deadline, streamed output and a process-group kill, and
 * resolves with the bounded outcome. A non-zero exit code is RETURNED (only a
 * spawn failure rejects), exactly like {@link runProcess}.
 */
export function runManaged(argv: readonly string[], options: RunManagedOptions): Promise<ManagedRunOutcome> {
  const started = Date.now()
  const inlineCap = options.maxOutputBytes
  const hardCap = inlineCap + (options.overflowBytes ?? inlineCap)
  const stdout: CappedStream = { inline: '', tail: '', totalBytes: 0, cut: false }
  const stderr: CappedStream = { inline: '', tail: '', totalBytes: 0, cut: false }

  let child: ChildProcess
  try {
    child = spawnManagedProcess(argv, options)
  } catch (error) {
    return Promise.reject(error)
  }
  const pid = child.pid ?? -1

  return new Promise<ManagedRunOutcome>((resolve, reject) => {
    let timedOut = false
    let settled = false
    let escalation: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      // SIGNAL ESCALATION on the WHOLE group: SIGTERM first (a process that
      // handles it can still flush its log), SIGKILL after the grace. Both
      // signals go to the group, so a shell's descendants die with it.
      killProcessGroup(pid, 'SIGTERM')
      escalation = setTimeout(() => killProcessGroup(pid, 'SIGKILL'), Math.max(0, options.killGraceMs ?? 0))
    }, options.timeoutMs)
    const stopTimers = (): void => {
      clearTimeout(timer)
      if (escalation !== undefined) clearTimeout(escalation)
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      pushChunk(stdout, text, inlineCap, hardCap)
      options.onStdout?.({ stream: 'stdout', text, bytes: data.byteLength, totalBytes: stdout.totalBytes })
    })
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf8')
      pushChunk(stderr, text, inlineCap, hardCap)
      options.onStderr?.({ stream: 'stderr', text, bytes: data.byteLength, totalBytes: stderr.totalBytes })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      stopTimers()
      reject(
        new ServiceError('spawn-failed', `cannot start '${argv[0] ?? ''}': ${error.message}`, {
          stage: options.stage ?? 'process.run',
          details: { command: argv[0] },
        }),
      )
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      stopTimers()
      const truncated = stdout.cut || stderr.cut
      resolve({
        pid,
        stdout: stdout.inline,
        stderr: stderr.inline,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        overflow: {
          ...(stdout.cut ? { stdout: stdout.tail } : {}),
          ...(stderr.cut ? { stderr: stderr.tail } : {}),
        },
        exitCode: timedOut ? null : code,
        signal: signal ?? null,
        durationMs: Date.now() - started,
        timedOut,
        killed: timedOut || signal !== null,
        truncated,
      })
    })

    if (child.stdin) {
      // A command that never reads stdin must not hold the runner: write, then
      // close, and ignore an EPIPE (the child exits without reading).
      child.stdin.on('error', () => undefined)
      if (options.stdin !== undefined) child.stdin.write(options.stdin)
      child.stdin.end()
    }
  })
}
