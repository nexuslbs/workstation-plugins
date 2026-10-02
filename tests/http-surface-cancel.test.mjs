import { strict as assert } from 'node:assert'
import test from 'node:test'
import { request } from 'node:http'

import { apply } from '../plugins/http-surface/index.ts'

/**
 * Regression guard for the "stopping an omniagent thread must stop its dsh
 * agents" leak (2026-10-02): the omniagent cancels a running tool call by
 * dropping the MCP call, which aborts the remote plugin's HTTP POST. The
 * workstation HTTP surface must turn that client disconnect into an abort of
 * the dispatched tool run (`exec.signal`), which is what makes the dsh-agent
 * tools kill their spawned worker process.
 */

/** A free-ish ephemeral port for one test (the plugin does not expose its port). */
function testPort(offset) {
  return 20000 + ((process.pid + offset) % 10000)
}

function waitForHealth(port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const tick = () => {
      const req = request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`http-surface did not listen on ${port}`))
        else setTimeout(tick, 25)
      })
      req.end()
    }
    tick()
  })
}

/** Boot the plugin with a fake ToolRuntime; returns the disposer. */
function startSurface(port, execute) {
  let dispose = () => {}
  const ctx = {
    tools: { schemas: () => [], execute },
    logger: { info: () => {}, warn: () => {} },
    effect: (callback) => {
      dispose = callback()
    },
  }
  // The plugin prefers $WORKSTATION_PORT over config.port; pin the test port.
  const previous = process.env.WORKSTATION_PORT
  delete process.env.WORKSTATION_PORT
  try {
    apply(ctx, { port })
  } finally {
    if (previous === undefined) delete process.env.WORKSTATION_PORT
    else process.env.WORKSTATION_PORT = previous
  }
  return () => dispose()
}

test('http-surface aborts the dispatched tool run when the client disconnects', async () => {
  const port = testPort(0)
  let resolveStarted
  const started = new Promise((resolve) => {
    resolveStarted = resolve
  })
  let resolveAbort
  const abortSeen = new Promise((resolve) => {
    resolveAbort = resolve
  })
  let aborted = false

  const dispose = startSurface(port, async (exec) => {
    resolveStarted()
    return await new Promise((resolve) => {
      const onAbort = () => {
        aborted = true
        resolveAbort()
        resolve('aborted')
      }
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  })

  try {
    await waitForHealth(port)
    const client = request({
      host: '127.0.0.1',
      port,
      path: '/api/tool/call',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    client.on('error', () => {})
    client.end(JSON.stringify({ tool: 'blocking', params: {} }))

    await started
    client.destroy() // the client (omniagent) is gone: drop the socket mid-run

    await Promise.race([
      abortSeen,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('the tool run did NOT observe the client disconnect within 3s')),
          3000,
        ),
      ),
    ])
    assert.equal(aborted, true, 'the tool body signal must abort on client disconnect')
  } finally {
    dispose()
  }
})

test('http-surface answers a normal (non-cancelled) request unchanged', async () => {
  const port = testPort(1)
  const dispose = startSurface(port, async () => ({ hello: 'world' }))

  try {
    await waitForHealth(port)
    const body = await new Promise((resolve, reject) => {
      const client = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/tool/call',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            text += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode, text }))
        },
      )
      client.on('error', reject)
      client.end(JSON.stringify({ tool: 'echo', params: {} }))
    })

    assert.equal(body.status, 200)
    const payload = JSON.parse(body.text)
    assert.equal(payload.status, 'ok')
    assert.equal(payload.tool, 'echo')
    assert.deepEqual(payload.result, { hello: 'world' })
  } finally {
    dispose()
  }
})
