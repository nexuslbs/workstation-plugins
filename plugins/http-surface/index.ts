/**
 * workstation HTTP surface - a MINIMAL NATIVE dsh plugin.
 *
 * The deepseek-harness headless profile mounts NO HTTP server (see
 * packages/bundle/headless/cordis.patch.yml: "It mounts no Host, HTTP server,
 * Web runtime, or browser plugin"), so the omni remote tool plugin
 * (`base_url: http://workstation:8080`, `tool_path: /api/tool/call`) would have
 * nothing to talk to. This plugin IS that surface, written as an ordinary
 * native dsh plugin: it injects the harness `tools` service (the ToolRuntime)
 * and dispatches through `ctx.tools.execute(...)` - the SAME registry every
 * native `defineTool` registration feeds. There is no workbench API here and no
 * shim: the plugin is typed, registered like any other plugin in the patch
 * file, and speaks exactly the contract the omni remote plugin expects:
 *
 *   GET  /health        -> { status, service, uptime_s, tools }
 *   GET  /api/tools     -> { status, tools: [names] }
 *   POST /api/tool/call -> body { tool|name, params|arguments }
 *                       -> 200 { status: 'ok', tool, result }
 *                       -> 200 { status: 'error', tool, error } (tool failure)
 *                       -> 400 { status: 'error', error } (bad request)
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'http-surface'

/** Cordis dependencies: the harness tool registry (required). */
export const inject = ['tools']

/** The harness ToolRuntime slice this plugin consumes (structural). */
interface ToolRuntimeLike {
  execute(request: {
    callId: string
    name: string
    arguments: Record<string, unknown>
    signal: AbortSignal
  }): Promise<{ isError?: boolean; error?: { message?: string }; value?: unknown }>
  schemas?(): Array<{ name?: string }>
}

interface PluginContext {
  tools: ToolRuntimeLike
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void }
  effect(callback: () => () => void): void
}

export interface Config {
  /** Listen port (default: $WORKSTATION_PORT or 8080). */
  port?: number
  /** Tool-call route (default /api/tool/call). */
  tool_path?: string
}

/** Read a whole request body as text. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  // The client may already be gone (cancelled dispatch): answering a destroyed
  // socket is pointless and can only raise a write-after-end error.
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(payload)
  res.setHeader('content-type', 'application/json')
  res.writeHead(status)
  res.end(body)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const started = Date.now()
  const port = Number(process.env.WORKSTATION_PORT ?? config.port ?? 8080)
  const toolCallPath = String(config.tool_path ?? '/api/tool/call')
  const tools = ctx.tools

  /** The tools the HARNESS registry holds (natively registered plugins). */
  const toolNames = (): string[] => {
    try {
      const schemas = tools.schemas?.() ?? []
      return schemas.map((schema) => schema.name).filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    } catch {
      return []
    }
  }

  /**
   * Dispatch through the harness ToolRuntime (the native registry).
   *
   * `signal` is the CALLER signal of this HTTP request: the harness fuses it
   * into the tool body's `exec.signal`, so a client that goes away aborts the
   * running tool instead of leaving it orphaned. The tool body owns the
   * reaction (the dsh-agent tools kill their spawned child process).
   */
  const callTool = async (toolName: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const exec = await tools.execute({
      callId: `ws-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: toolName,
      arguments: params ?? {},
      signal,
    })
    if (exec && exec.isError === true) {
      throw new Error(exec.error?.message ?? `tool "${toolName}" failed`)
    }
    return exec?.value ?? exec
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = String(req.url ?? '/')
      if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'workstation',
          uptime_s: Math.round((Date.now() - started) / 1000),
          tools: toolNames().length,
        })
      }
      if (req.method === 'GET' && url === '/api/tools') {
        return sendJson(res, 200, { status: 'ok', tools: toolNames() })
      }
      if (req.method === 'POST' && (url === toolCallPath || url === '/api/tool/call')) {
        const raw = await readBody(req)
        let body: Record<string, unknown> = {}
        try {
          body = raw ? JSON.parse(raw) : {}
        } catch {
          return sendJson(res, 400, { status: 'error', error: 'invalid JSON body' })
        }
        const toolName = typeof body.tool === 'string' ? body.tool : typeof body.name === 'string' ? body.name : undefined
        if (!toolName) return sendJson(res, 400, { status: 'error', error: 'missing "tool"' })
        const params = (body.params ?? body.arguments ?? {}) as Record<string, unknown>
        // ONE AbortController per request: it is the caller signal handed to
        // the tool body AND it fires when this HTTP client goes away (the
        // omniagent stopped the thread / ran core__cancel_task, so the remote
        // plugin aborted its POST and this socket closed). Without it a
        // disconnected dispatch kept running to completion - the dsh agent of
        // `delegate` / `agent_run` burned tokens with no consumer left.
        const controller = new AbortController()
        const onClientGone = (): void => {
          if (res.writableFinished) return // normal completion, not a disconnect
          if (controller.signal.aborted) return
          controller.abort(new Error('http client disconnected'))
          ctx.logger?.warn?.('http-surface: client disconnected during tool "%s"; cancelling the run', toolName)
        }
        res.on('close', onClientGone)
        req.on('aborted', onClientGone)
        try {
          const result = await callTool(toolName, params, controller.signal)
          return sendJson(res, 200, { status: 'ok', tool: toolName, result })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (controller.signal.aborted) {
            ctx.logger?.warn?.('http-surface: tool "%s" cancelled after client disconnect: %s', toolName, message)
            return sendJson(res, 200, { status: 'error', tool: toolName, error: `cancelled: ${message}` })
          }
          return sendJson(res, 200, { status: 'error', tool: toolName, error: message })
        } finally {
          res.off('close', onClientGone)
          req.off('aborted', onClientGone)
        }
      }
      return sendJson(res, 404, { status: 'error', error: 'not found' })
    } catch (err) {
      try {
        return sendJson(res, 500, { status: 'error', error: err instanceof Error ? err.message : String(err) })
      } catch {
        return undefined
      }
    }
  })

  ctx.effect(() => {
    server.listen(port, '0.0.0.0', () => {
      ctx.logger?.info?.('http-surface: listening on :%d (%d tool(s))', port, toolNames().length)
    })
    return () => {
      try {
        server.close()
      } catch {
        /* ignore */
      }
    }
  })
}

export default { name, inject, apply }