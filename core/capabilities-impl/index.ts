// External workbench plugin: the HOST of the capability SERVICE OBJECTS that the
// public `definitions/` of this repository publish and that no provider hosts
// itself (`totp@1`, `sms@1`).
//
// WHY THIS PLUGIN EXISTS. A capability has three roles (core
// `docs/PLUGIN-CONTRACT.md`, sections 4f/4g):
//   * Definition - the typed contract, the contract version and the
//     `ctx.totp` / `ctx.sms` handle: `definitions/totp.ts`, `definitions/sms.ts`
//     of THIS repository;
//   * Provider   - a backend that DECLARES the provider id it answers for in its
//     manifest and registers an implementation (`core/totp-rfc6238`,
//     `core/sms-twilio`). The manifest declaration is what makes
//     `register()` legal, and it is also what makes a provider SELECTABLE;
//   * Consumer   - an operator surface that only injects (`plugins/totp-tools`,
//     `plugins/sms-tools`).
//
// Until core v0.0.3 the CORE instantiated the Definition and declared the
// provider ids its discovery carried. Since v0.0.4 the core owns no feature
// module and no capability service (the definitions moved HERE), so someone has
// to instantiate the Definition, DECLARE the provider ids and provide the
// service under the capability name - that is this plugin, and nothing else.
// Without it a provider that injects `totp`/`sms` never applies (its backend is
// never registered) and a consumer registers no tool at all.
//
// The hosted providers come from the SIBLING MANIFESTS: `core/*` sit next to
// this plugin inside the same source checkout, so a NEW provider plugin is
// hosted with NO config edit - its manifest capability is enough. Declarations
// are made for every discovered sibling, loaded or not, so enabling or disabling
// a provider stays a CONFIG-only edit (the definition walks the ENABLED
// providers and the first registered one answers).
//
// The plugin touches no key and no operator backend: it imports the two
// Definitions (the contracts) and provides two services. A deployment that wants
// no TOTP (or no SMS) sets `totp: false` (respectively `sms: false`) in its own
// row; `definitions/` stay untouched.

import { loggerOf } from '../../definitions/logger.ts'
import fs from 'node:fs'
import path from 'node:path'
import { SMS, SMS_VERSION, Sms } from '../../definitions/sms.ts'
import { TOTP, TOTP_VERSION, Totp } from '../../definitions/totp.ts'
import type { DefinitionContext as SmsContext, SmsProviderDeclaration } from '../../definitions/sms.ts'
import type { ServiceContext } from '../../definitions/support.ts'
import type { DefinitionContext as TotpContext, TotpProviderDeclaration } from '../../definitions/totp.ts'

export const name = 'capabilities-impl'

/** The plugin manifest file name, exactly as the core reads it (`src/loader.ts`). */
const MANIFEST_FILE = 'workbench.plugin.json'

/**
 * The `source` label declared for the hosted providers. It is DISPLAY metadata
 * (it shows up in `providers()` and in the inventory), mirroring the `source`
 * the core's discovery reports for the plugins of this repository.
 */
const DEFAULT_SOURCE = 'workbench-plugins'

export interface Config {
  /** Source label reported for the declared providers (default `workbench-plugins`). */
  source?: string
  /** Whether the declared providers came from an external source (default true). */
  external?: boolean
  /** Provide `ctx.totp` (default true). */
  totp?: boolean
  /** Provide `ctx.sms` (default true). */
  sms?: boolean
  /** Provider ids to ENABLE for `totp`, in precedence order (default: every declared one). */
  totpProviders?: readonly string[]
  /** Provider ids to ENABLE for `sms`, in precedence order (default: every declared one). */
  smsProviders?: readonly string[]
}

/** One provider capability a sibling manifest claims. */
export interface HostedProvider {
  /** The capability id the manifest claims (`totp`, `sms`, ...). */
  capability: string
  /** The provider id the plugin claims. */
  provider: string
  /** The contract version the plugin claims (1 when the manifest omits it). */
  version: number
  /** The declaring plugin (the manifest `name`). */
  plugin: string
}

/**
 * Every provider capability the SIBLING plugin manifests of the same source
 * checkout claim. This plugin's module sits in `<source>/core/capabilities-impl`,
 * so the parent directory holds one subdirectory per plugin of that checkout.
 *
 * The scan is deliberately forgiving: a directory without a manifest, an
 * unreadable file or a malformed capability row is SKIPPED (a broken sibling is
 * the loader's business, never a reason for the host to fail), and only the
 * structured capability form can carry a provider id - the short string form
 * (`"command:hello world"`) is not a provider contract.
 */
export function siblingProviders(moduleUrl: string): HostedProvider[] {
  const root = path.dirname(path.dirname(new URL(moduleUrl).pathname))
  const found: HostedProvider[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return found // no sibling tree (a test harness, a vendored single plugin)
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const file = path.join(root, entry.name, MANIFEST_FILE)
    if (!fs.existsSync(file)) continue
    let manifest: { name?: unknown; capabilities?: unknown }
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: unknown; capabilities?: unknown }
    } catch {
      continue
    }
    if (!Array.isArray(manifest.capabilities)) continue
    for (const capability of manifest.capabilities) {
      if (capability === null || typeof capability !== 'object' || Array.isArray(capability)) continue
      const { id, provider, version } = capability as { id?: unknown; provider?: unknown; version?: unknown }
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof provider !== 'string' || provider.length === 0) continue
      found.push({
        capability: id,
        provider,
        version: typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 1,
        plugin: typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : entry.name,
      })
    }
  }
  return found
}

/**
 * The plugin entrypoint: it PROVIDES the two capability services of this
 * repository's definitions that have no provider host. `new Totp(ctx)` /
 * `new Sms(ctx)` provide the service under the capability name (the definitions'
 * own seam) and the declarations are made in the SAME synchronous apply, so a
 * provider whose fiber was waiting on `inject: [TOTP]` can only run once the
 * service is fully declared.
 */
export function apply(ctx: ServiceContext, config: Config = {}): void {
  const source = typeof config.source === 'string' && config.source.length > 0 ? config.source : DEFAULT_SOURCE
  const external = config.external !== false
  const providers = siblingProviders(import.meta.url)

  if (config.totp !== false) {
    const totp = new Totp(ctx as unknown as TotpContext)
    const declared = declareInto(providers, TOTP, (hosted) =>
      totp.declare({
        provider: hosted.provider,
        version: hosted.version || TOTP_VERSION,
        plugin: hosted.plugin,
        source,
        external,
      } satisfies TotpProviderDeclaration),
    )
    if (config.totpProviders !== undefined) totp.setEnabled(config.totpProviders)
    loggerOf(ctx, name).info(`provided totp@${TOTP_VERSION} - declared provider(s): ${declared}`)
  }

  if (config.sms !== false) {
    const sms = new Sms(ctx as unknown as SmsContext)
    const declared = declareInto(providers, SMS, (hosted) =>
      sms.declare({
        provider: hosted.provider,
        version: hosted.version || SMS_VERSION,
        plugin: hosted.plugin,
        source,
        external,
      } satisfies SmsProviderDeclaration),
    )
    if (config.smsProviders !== undefined) sms.setEnabled(config.smsProviders)
    loggerOf(ctx, name).info(`provided sms@${SMS_VERSION} - declared provider(s): ${declared}`)
  }
}

/** Declares every hosted provider of one capability, returning the declared ids. */
function declareInto(
  providers: readonly HostedProvider[],
  capability: string,
  declare: (hosted: HostedProvider) => void,
): string {
  const declared: string[] = []
  for (const hosted of providers) {
    if (hosted.capability !== capability) continue
    declare(hosted)
    declared.push(`${hosted.provider} (${hosted.plugin})`)
  }
  return declared.length > 0 ? declared.join(', ') : 'none'
}

export default { name, apply }
