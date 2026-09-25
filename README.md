# workstation-plugins

Plugins for the [deepseek-harness](https://github.com/nexuslbs/deepseek-harness)
workstation service.

This repository is a **mirror of `nexuslbs/workbench-plugins`** that speaks the
deepseek-harness plugin API natively, so the workstation service can stand on
its OWN plugin source (no workbench dependency, no compat shim). It is consumed
as an **external plugin source**: the harness loads these modules through cordis
patch entries (a `dsh --patch` overlay naming each plugin by absolute path), not
through a workbench-style `sources:`/`plugins:` roster. See the workstation
config in the omni-root stack (`config/workstation.yml`) for the patch form.

## The seam (what changed vs workbench-plugins)

The workbench-plugins were written against the workbench core cordis API, which
differs from the harness API in exactly two places. This mirror carries the
types/schemas the harness expects, so the workstation-http compat shim can be
retired:

| Seam | workbench-plugins (old) | workstation-plugins (this repo) |
| --- | --- | --- |
| Tool registration | `ctx.tools.registerTool({ name, description, parameters, handler })` | `ctx.tools.register(defineTool({ name, description, parameters, execute, output }))` (`definitions/tools.ts`) |
| Credentials | `${cred:NAME}` kernel expansion in config | `ctx.credentials.resolve({ name })` at call time (`definitions/credentials.ts`) |

- `definitions/` is copied verbatim EXCEPT the two seams (`tools.ts`,
  `credentials.ts`), which carry the deepseek-harness types/schemas:
  - `tools.ts` - the harness `ToolRuntime` contract: `defineTool({execute,
    output})` where `output.schema` + `output.render` are REQUIRED, plus the
    author-form parameter DSL (`ParameterSchemaSpec`), `validateArgs` and the
    generic `renderValue` renderer every consumer uses.
  - `credentials.ts` - the harness credentials service contract
    (`resolve(ref)` -> `{ value, source }`, `readRecord(key)`); a config value
    that names a credential is a NAME resolved through `ctx.credentials` at
    call time, never a `${cred:...}` string substituted before `apply`.
- Consumer plugins register their tools through
  `ctx.tools.register(defineTool({...}))`; provider plugins already resolved
  credential NAMEs through `ctx.credentials` at call time and are unchanged.
- `workbench.plugin.json` is kept as the plugin MANIFEST (name, entry,
  capabilities, config schema); DISCOVERY is expressed through cordis patch
  entries in the workstation config, not through a workbench roster.

## Layout

```
core/                        # the CORE SERVICE IMPLEMENTATIONS (table below)
  <service-plugin>/
    workbench.plugin.json    # manifest (name, version, entry, capabilities, config)
    index.ts                 # entry module (cordis plugin, ESM)
plugins/                     # consumers, operator tools
  <plugin-name>/
    workbench.plugin.json
    index.ts
definitions/                 # the CONTRACTS (definitions/<capability>.ts): imported by
                             # providers AND consumers, so a provider is swappable by config
shared/                      # shared runtime helpers (the chromium launcher)
lib/                         # shared process runner
```

The rule that decides the tree:

| Tree | What belongs there |
| --- | --- |
| `core/` | an IMPLEMENTATION of a service: a capability provider (`capabilities: [{id, version, provider}]`) whose contract is a `definitions/` module, or the SERVICE HOST that provides such a contract |
| `plugins/` | everything that CONSUMES a core service: operator tools - it imports `definitions/` and registers tools |

## Minimum viable subset

This mirror carries the plugin subset the first working workstation loads
(mirror of `config/workstation.yml` of the omni-root stack):

- `core/`: `general-service-impl`, `shell-impl`, `docker-impl`,
  `capabilities-impl`, `himalaya-impl`, `email-himalaya`, `sms-twilio`,
  `totp-rfc6238`, `browser-use-impl`, `browser-use-playwright`
- `plugins/`: `email-tools`, `sms-tools`, `totp-tools`, `browser-use-tools`,
  `web-search-tools`, `web-session`

External-service targets (himalaya in `toolbox`, the browser service, the
credential NAMEs) are CONFIGURED in the user repo (omni-root
`config/workstation.yml`), never hardcoded here, and nothing in the workstation
image ships a browser or himalaya.

## Develop / verify

```bash
npm install
npm run typecheck
```

## License

MIT.