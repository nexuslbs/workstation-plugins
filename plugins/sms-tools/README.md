# sms-tools

External workbench plugin: the **CONSUMER** of the core contract **`sms@1`**
(core `docs/PLUGIN-CONTRACT.md` section 4g).

It imports **nothing** from the core and **nothing** from a provider. The only
seams it touches are `ctx.sms` (the capability, injected by name) and
`ctx.tools.registerTool`. Swapping the provider - disable one `sms@1`
provider, enable another - is a config edit: this plugin does not change and its
tools keep working. That direction is enforced by `npm run check:seam` in the
core repository.

No SMS backend and no phone number appears in the executable code here: a number
is always the **LABEL** the operator configured, forwarded verbatim.

## Tools

| Tool | Parameters | What it does |
| --- | --- | --- |
| `sms numbers` | `format?` (`labels` default, `full`) | the configured number **labels**, which one is the default, and (with `full`) each label's `number`, `configured` and `description` - never a secret |
| `sms list` | `number?`, `limit?` (default 10, max 50), `since?`, `from?`, `unreadOnly?` | the newest inbound messages of a number; a missing/blank `number` means the provider's configured default |
| `sms get` | `id` (**required**), `number?` | one message by id: full (bounded) body plus sender, recipient, date and delivery metadata |
| `sms code` | `number?`, `id?`, `query?`, `pattern?`, `occurrences?`, `maxAgeSeconds?` | extracts a **verification code** from a message (the given `id`, or the newest message matching `query`) and says which message it came from |

Every parameter is declared in the tool's JSON schema, so the core validates it
over `POST /api/tools/<name>` (alias `POST /api/tool/call {"tool","params"}`)
before the handler runs; the handlers additionally refuse a blank required
`id` with a readable message.

The extraction rule itself lives in the **Definition** (one place, every
provider): digits-first 4-8 digit codes, alphanumeric fallback, `pattern`
overrides, `occurrences` picks the candidate. This plugin only picks the message.

## Configuration

```yaml
plugins:
  sms-tools:
    defaultListLimit: 10   # default 'limit' of 'sms list'
    maxListLimit: 50       # cap accepted from a client (never above the contract's 100)
    includeBodies: true    # false: 'sms list' reports metadata without bodies
```

The numbers themselves are the **provider's** configuration (see
`core/sms-twilio/README.md`); this consumer never sees a credential.

## Example calls

```sh
curl -s -X POST http://127.0.0.1:8080/api/tools/'sms%20numbers' -H 'content-type: application/json' -d '{}'
curl -s -X POST http://127.0.0.1:8080/api/tools/'sms%20list'    -H 'content-type: application/json' -d '{"number":"personal","limit":5}'
curl -s -X POST http://127.0.0.1:8080/api/tools/'sms%20get'     -H 'content-type: application/json' -d '{"id":"SMxxxxxxxx"}'
curl -s -X POST http://127.0.0.1:8080/api/tools/'sms%20code'    -H 'content-type: application/json' -d '{"number":"personal","query":"Verify"}'
```

## Tests

`test/sms-tools.test.ts` drives `apply()` with a FAKE `ctx.sms` (the Definition
surface, no backend) and asserts the tool names, the parameter schemas, the
forwarding of the number label and options, the required-`id` refusal, the
capability error pass-through and the provider-agnostic property. Nothing here
imports a provider or the core.

```sh
npm test        # from the repository root
```
