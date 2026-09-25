// The SHARED chromium launcher of this plugin repository.
//
// `web-page` (single-shot reads) and `web-session` (persistent, storage-state
// sessions) both need a browser, and two plugins each launching their own
// chromium would pay for two browser processes on the same host and could
// exhaust memory on a small deployment. This module owns ONE lazily launched
// process per workbench process, shared through a refcount:
//
//   acquireSharedBrowser(options) -> the process (launched on first use)
//   releaseSharedBrowser()        -> drops THIS holder; the browser is closed
//                                    only when the last holder releases it
//
// It lives in `shared/` (OUTSIDE the `core/`, `plugins/` and `examples/`
// trees) WITHOUT a `workbench.plugin.json`, so the core's discovery walk (a
// source scans exactly ONE directory, and a plugin directory must carry a
// manifest) never treats it as a plugin: it is an internal module of this
// repository, not a roster entry. It sits outside the plugin trees on purpose:
// `scripts/check-seam.ts` rule 4 lets a PROVIDER import its own directory and
// the definitions only, so the shared launcher must live where both the
// consumers (`plugins/web-page`, `plugins/web-session`) and the provider
// (`core/browser-use-playwright`) may import it.
//
// `playwright-core` is imported DYNAMICALLY, here, inside the launch path: a
// deployment without the module still LOADS every plugin and answers a
// structured error (the caller wraps the failure) instead of crashing the
// process at import time. The browser itself is a DEPLOYMENT input
// (`executablePath` config or `PLAYWRIGHT_BROWSERS_PATH`), never a hidden side
// effect of installing the package - see plugins/web-page/README.md.
import type { Browser } from 'playwright-core'

export interface SharedBrowserOptions {
  /** Chromium binary; absent: playwright resolves it (PLAYWRIGHT_BROWSERS_PATH). */
  executablePath?: string
  /** Extra chromium argv. */
  args: string[]
  /** Launch timeout in ms. */
  timeoutMs: number
  /** Per-request proxy (a VALUE password is resolved by the caller). */
  proxy?: { server: string; username?: string; password?: string }
  /** Headless (default true). */
  headless?: boolean
}

interface SharedState {
  browser: Browser
  /** How many plugins/objects currently hold the process. */
  holders: number
}

let shared: SharedState | undefined
let launching: Promise<SharedState> | undefined
let launchCount = 0

/**
 * The browser of this workbench process, launched on first use and shared by
 * every caller. The FIRST caller's options win (one deployment, one browser
 * config); later callers with a different config still get the running process
 * rather than a second one - that is the point of the module.
 */
export async function acquireSharedBrowser(options: SharedBrowserOptions): Promise<Browser> {
  if (shared !== undefined && shared.browser.isConnected()) {
    shared.holders += 1
    return shared.browser
  }
  // A launch IN FLIGHT is coalesced (two concurrent callers share one process);
  // a SETTLED one is NOT reused. Reusing the settled promise handed out the
  // browser of the LAST holder after it had been closed, so the next caller died
  // with "Target page, context or browser has been closed" instead of getting a
  // fresh process - only a LIVE browser may be reused.
  let pending = launching
  if (pending === undefined) {
    pending = launch(options)
    launching = pending
    void pending.then(
      () => {
        if (launching === pending) launching = undefined
      },
      () => {
        if (launching === pending) launching = undefined
      },
    )
  }
  const state = await pending
  state.holders += 1
  return state.browser
}

/** Drop one holder; the last one closes the browser (a no-op when none is open). */
export async function releaseSharedBrowser(): Promise<void> {
  const state = shared
  if (state === undefined) return
  state.holders = Math.max(0, state.holders - 1)
  if (state.holders > 0) return
  shared = undefined
  await state.browser.close().catch(() => undefined)
}

/** Launch/refcount diagnostics (a plugin can report them without a browser). */
export function sharedBrowserStats(): { launches: number; holders: number; connected: boolean } {
  return {
    launches: launchCount,
    holders: shared === undefined ? 0 : shared.holders,
    connected: shared !== undefined && shared.browser.isConnected(),
  }
}

/**
 * The version of the RUNNING browser (playwright reports it), or undefined when
 * no browser is up. It is read from the live process, never guessed from the
 * path: an engine report must not claim a version it did not observe.
 */
export function sharedBrowserVersion(): string | undefined {
  return shared !== undefined && shared.browser.isConnected() ? shared.browser.version() : undefined
}

/** Close the shared browser unconditionally (tests / a host shutdown hook). */
export async function closeSharedBrowser(): Promise<void> {
  const state = shared
  shared = undefined
  if (state !== undefined) await state.browser.close().catch(() => undefined)
}

async function launch(options: SharedBrowserOptions): Promise<SharedState> {
  const playwright = await import('playwright-core').catch((error: unknown) => {
    launching = undefined
    throw new Error(`the playwright-core module could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
  })
  const launchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
    headless: options.headless ?? true,
    args: options.args,
    timeout: options.timeoutMs,
  }
  if (options.executablePath !== undefined) launchOptions.executablePath = options.executablePath
  if (options.proxy !== undefined) launchOptions.proxy = options.proxy
  const browser = await playwright.chromium.launch(launchOptions)
  launchCount += 1
  const state: SharedState = { browser, holders: 0 }
  shared = state
  // A browser that dies on its own (crash, operator kill) is dropped here, so
  // the next acquire launches a fresh one instead of handing out a dead handle.
  browser.on('disconnected', () => {
    if (shared === state) shared = undefined
  })
  return state
}
