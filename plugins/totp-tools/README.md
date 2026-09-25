# totp-tools - the TOTP **consumer** (`totp@1`)

External plugin for the workbench `totp@1` capability seam (core
`docs/PLUGIN-CONTRACT.md`, section 4f). It is the **Consumer** role:

| Role | Where | What |
| --- | --- | --- |
| Definition | core `src/totp/definition.ts` (`ctx.totp`) | the contract: `entries()`, `code(label, { at })` |
| Provider | `core/totp-rfc6238` | RFC 4226/6238 TOTP over `node:crypto` HMAC |
| **Consumer** | **this plugin** | the tools `totp list` / `totp code` |

It imports nothing from the core and nothing from a provider. The only seams it
touches are `ctx.totp` (injected by name) and `ctx.tools.registerTool`, so
swapping the provider is a config edit and this file never changes.

## Tools

Registered through the core's by-name tool surface (`POST /api/tools/<name>`,
alias `POST /api/tool/call {"tool","params"}`):

### `totp list`

No parameters. Answers the configured entries as **metadata only**:

```json
{
  "count": 2,
  "entries": [
    { "label": "github", "issuer": "GitHub", "account": "me@example.com", "digits": 6, "period": 30, "algorithm": "SHA1", "configured": true },
    { "label": "aws-root", "digits": 6, "period": 30, "algorithm": "SHA1", "configured": false }
  ]
}
```

`configured: false` means the entry exists but has no usable key (no key
declared, or its credential did not resolve); calling it reports exactly that.

### `totp code`

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `label` | string | **yes** | entry label, as reported by `totp list` |
| `at` | integer | no | unix **seconds** to generate for (default: now) |

```json
{
  "label": "github",
  "code": "287082",
  "digits": 6,
  "period": 30,
  "algorithm": "SHA1",
  "generatedAt": 59,
  "remainingSeconds": 1,
  "issuer": "GitHub",
  "account": "me@example.com"
}
```

A missing `label` is rejected by the core's schema validation with a **400** and
a readable `error.violations` list; an unknown label answers a structured
**500** error (`error.kind: "tool-failed"`, message
`totp: unknown entry '<label>' (configured: ...)`) and the service keeps
serving. A key value is never part of any answer.

## Configuration

```yaml
plugins:
  totp-rfc6238:          # the PROVIDER (see its README for the entries)
    entries: {}
  totp-tools:            # THIS plugin: the consumer
    reportEntryMetadata: true
```

`reportEntryMetadata: false` drops the `issuer`/`account` fields from a
`totp code` answer (they stay in `totp list`).

## Wiring the capability

```yaml
sources:
  - kind: path            # or kind: git in production
    id: workbench-plugins
    path: ./plugins
plugins:
  totp-rfc6238: { entries: { github: { credential: TOTP_GITHUB_KEY } } }
  totp-tools: {}
```

No core change is involved: the provider's manifest declaration plus these config
rows are the whole wiring. `npm run check:seam` in the core repository enforces
that this consumer never imports a provider (and vice versa).

## Tests

```sh
npm test      # from the workbench-plugins root
```

`test/totp-tools.test.ts` boots this plugin against a FAKE `ctx.totp` and checks
the registered tool names and schemas, the required `label`, the forwarding of
`at`, that `totp list` exposes metadata only, and that swapping the provider
behind `ctx.totp` leaves every tool byte-identical.
