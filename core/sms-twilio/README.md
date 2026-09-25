# sms-twilio

External workbench plugin: an **SMS service PROVIDER** that implements the core
contract **`sms@1`** (core `docs/PLUGIN-CONTRACT.md` section 4g) on the
**Twilio REST API**.

| Role | Where |
| --- | --- |
| Definition (the contract, `ctx.sms`) | core repo `nexuslbs/workbench`, `src/sms/definition.ts` |
| Provider (**this plugin**) | declares `{"id":"sms","version":1,"provider":"twilio"}` in `workbench.plugin.json` |
| Consumer (tools) | `plugins/sms-tools` in this repo |

This plugin imports **nothing** from the core: the kernel injects `ctx.sms` and
`ctx.credentials`, and the manifest capability is what makes
`ctx.sms.register(...)` legal.

## Scope: READ-ONLY

Only `GET` requests on the Twilio **Messages** resource. **No SMS sending**, no
TwiML/webhook server, no number purchase or provisioning, no LLM post-processing.
If you need to send, that is a different plugin (and a different capability).

## Twilio endpoints used (API version `2010-04-01`)

`2010-04-01` is the only version Twilio publishes for the Messages resource; it
is part of every request path.

| Capability call | Twilio request |
| --- | --- |
| `ctx.sms.list({ label }, { limit, since, from, unreadOnly })` | `GET https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json?To={number}&PageSize={n}` then, while the answer carries a `next_page_uri`, `GET {apiBase}{next_page_uri}` |
| `ctx.sms.get({ label }, sid)` | `GET https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json` |
| `ctx.sms.numbers()` | no request: the configured rows, with a `configured` flag |
| `ctx.sms.code(...)` / `ctx.sms.search(...)` | no request of their own: the **core definition** implements both on top of `list()`/`get()` |

Authentication is HTTP Basic: `Authorization: Basic base64({AccountSid}:{AuthToken})`.
The `apiBase` of a number can be overridden per row (a proxy, or a stub server in
tests). Every request is bounded: `timeoutMs` (default 8000), a `PageSize` capped
at Twilio's 100, at most `maxPages` pages (default 3), and message bodies capped
at `maxBodyChars` (default 2000, the contract's cap).

Field mapping: `sid -> id`, `from -> from`, `to -> to`, `date_created` (RFC 2822,
normalised to ISO-8601) `-> date`, `body -> body`, `status -> status`,
`num_segments -> segments`, `direction -> direction`, `error_message -> error`.

`unreadOnly` / `unread`: **Twilio keeps no read/unread flag on a message.** The
provider treats the inbound final status `received` as "not marked read", so
`unread` is `true` for inbound messages and `unreadOnly: true` keeps them all.
Use `since`, `from` and `limit` to narrow a listing.

## Configuration

One row per **LABEL**; the label is the only identifier a caller passes, and
labels may live in **different Twilio accounts** (one credential pair per label).

```yaml
plugins:
  sms-twilio:
    defaultNumber: personal          # the label a call without a reference resolves to
    numbers:
      personal:
        number: "+15551234567"       # the TO number whose inbox is read
        accountSid: ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
        authToken: ${cred:TWILIO_PERSONAL_TOKEN}   # PREFERRED: a credential reference
        description: personal phone
      work:
        number: "+15557654321"
        accountSid: ACyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
        authToken: ${cred:TWILIO_WORK_TOKEN}
    timeoutMs: 8000
    maxPages: 3
    pageSize: 100
    maxBodyChars: 2000
```

### Credentials (names, never values)

`accountSid` and `authToken` accept either a **literal** or the core's
`${cred:NAME}` **reference** spelling (`docs/CREDENTIALS.md`). A **capability
provider** is applied in the kernel's first phase, before `${cred:...}`
expansion, so a reference reaches this plugin **unexpanded** and is resolved
here, at **call time**, through `ctx.credentials`.

`authToken` additionally accepts a bare **credential NAME** (`TWILIO_WORK_TOKEN`,
no `${...}` wrapper). It is the form the dev `config.yml` uses, for a reason: the
kernel expands `${cred:NAME}` **while it loads the config**, and a name that does
NOT resolve there is **fatal for the whole boot** (`config: credential '...'
could not be resolved by the enabled provider(s)`, the process exits). A bare
NAME is never expanded by the kernel, so an empty credential store leaves the
workbench **bootable**: the label is reported `configured: false`, the plugin
stays **loaded** (never under `failures`, contract rule 6) and only a call for
that label fails, naming the **credential NAME**. Use `${cred:...}` only when the
credential is guaranteed to exist at boot.

That has two further consequences worth knowing:

- a credential that is missing, empty or rotated **later** does not break the
  plugin (and a value that appears after boot starts working with no reload);
- a literal token works too, but keeps the value in the config file: prefer a
  reference.

Required credential names for the row above: `TWILIO_PERSONAL_TOKEN` and
`TWILIO_WORK_TOKEN` (values live in the credential store, never in this repo).
An `accountSid` may also be `${cred:TWILIO_PERSONAL_SID}` if you prefer.

**Never commit an auth token.** This README and the committed config carry
names only; a real token belongs in the credential store.

## Errors

Structured, never fatal, never echoing a credential:

| Situation | Error |
| --- | --- |
| label is not configured by this provider | `SmsUnknownNumberError` (`sms: unknown number 'x' (configured: ...)`) |
| the label's row is incomplete, or a reference did not resolve | `SmsNumberNotConfiguredError` (`sms: number 'x' is not configured (credential 'NAME' did not resolve to a value)`) |
| `get()` for an unknown sid | `SmsNotFoundError` (HTTP 404) |
| Twilio answers an error status, or the request fails/times out | `SmsBackendError` (`sms: number 'x': the sms backend answered HTTP 401 (code 20003: Authenticate)`, or `the request failed (timed out after 8000ms)`) |

## Tests

`test/sms-twilio.test.ts` drives the provider against a **stub HTTP server**
(`node:http`) that speaks the Twilio shapes: pagination via `next_page_uri`,
the `To`/`PageSize` query parameters, Basic auth, error statuses, the body cap,
the `since`/`from`/`unreadOnly` filters and the not-configured path. No network
access and no real credential is needed.

```sh
npm test        # from the repository root
```
