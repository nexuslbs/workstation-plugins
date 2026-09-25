# capabilities-impl

The capability **SERVICE HOST** of this repository: it provides `ctx.totp`
(`totp@1`) and `ctx.sms` (`sms@1`), the two capability services whose Definition
lives in `definitions/` and which no provider plugin hosts itself.

## Why it exists

A capability is three roles (core `docs/PLUGIN-CONTRACT.md`, sections 4f/4g):

| Role | Who | Where |
| --- | --- | --- |
| Definition | the typed contract + the `ctx.totp` / `ctx.sms` handle | `definitions/totp.ts`, `definitions/sms.ts` (this repository) |
| Provider | a backend that declares its provider id in its manifest and registers it | `core/totp-rfc6238`, `core/sms-twilio` |
| Consumer | an operator surface that only injects the service | `plugins/totp-tools`, `plugins/sms-tools` |

Until core v0.0.3 the **core** instantiated the Definition and declared the
provider ids it found in the manifests. Since v0.0.4 the core owns no feature
module and no capability service (the definitions moved into this repository), so
someone has to:

1. instantiate the Definition (`new Totp(ctx)` / `new Sms(ctx)` provides the
   service under the capability name - the definitions' own seam),
2. **declare** every provider id a manifest claims (a declaration is what makes
   `ctx.totp.register()` / `ctx.sms.register()` legal), and
3. select the enabled providers when the deployment asks for a precedence.

This plugin does exactly that and nothing else.

## Configuration

The hosted providers come from the **sibling manifests**
(`core/*/workbench.plugin.json`), so a new provider plugin needs no config
edit: its manifest capability is enough, and the declaration is made whether or
not that provider row is currently enabled (so enabling or disabling a provider
stays a config-only edit). Every config field of this plugin is optional:

```yaml
plugins:
  capabilities-impl: {}          # host both, declare every sibling provider
  # capabilities-impl:
  #   source: workbench-plugins  # display label reported by providers()
  #   external: true             # display metadata (this repository is external)
  #   totp: true                 # provide ctx.totp          (false: do not)
  #   sms: true                  # provide ctx.sms           (false: do not)
  #   totpProviders: [rfc6238]   # enable/precedence (default: every declared)
  #   smsProviders: [twilio]
```

A provider id that **no** sibling manifest declares is refused by
`ctx.totp.register()` / `ctx.sms.register()`: the manifest declaration stays the
gate, exactly as the contract requires.

## Test

`test/capabilities-impl.test.ts` drives the plugin with a stub cordis context:
it asserts the sibling scan finds the real provider ids, that the service is
provided and declared, that a stub provider registers and answers through the
definition, and that an undeclared provider id is refused.
