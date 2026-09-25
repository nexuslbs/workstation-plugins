# email-tools

An **external consumer** of the workbench email capability (`email@1`): it turns
the capability into the four operator-facing TOOLS below and never learns which
backend answers. It imports nothing from the core and nothing from a provider -
its whole seam is `ctx.email` plus `ctx.tools.registerTool`, which is what
keeps the provider swappable by config alone.

## Tools

| Tool | Parameters (type) | Result |
| --- | --- | --- |
| `email accounts` | `format?` (`string`, enum `labels`\|`full`, default `labels`) | `{ count, default, accounts }` - labels only, or the full account objects (address, default flag, backend description). Never a secret. |
| `email list` | `account?` (`string`), `folder?` (`string`), `limit?` (`integer`, default 10, capped at 50 by `maxListLimit`), `unreadOnly?` (`boolean`), `since?` (`string`, ISO-8601) | `{ account, count, messages: [{ id, subject, from, to, date, unread, snippet?, folder? }] }` |
| `email get` | `id` (`string`, **required**), `account?` (`string`), `format?` (`string`, enum `text`\|`markdown`\|`raw`, default `text`) | `{ account, id, subject, from, to, date, unread, format, body, attachments: [{ filename, contentType?, size? }] }` |
| `email code` | `account?` (`string`), `id?` (`string`), `query?` (`string`), `pattern?` (`string`), `maxAgeSeconds?` (`integer`) | `{ account, code, subject, from, date, messageId }` - the extracted verification code plus the mail it came from |

Parameter semantics, exactly as the definition specifies them:

- **`account` omitted (or blank) means the DEFAULT ACCOUNT** - the one the
  provider selected in its own config (`plugins.email-himalaya.defaultAccount`).
  This plugin never holds a default of its own: it passes the reference through
  and lets the provider decide, so "multi-account + a configured default" stays
  a provider/config concern.
- `format` in `email get` selects the body field returned (`raw` returns the raw
  RFC822 message, bounded by the provider).
- `email code` without `id` scans the newest messages (the definition's
  `DEFAULT_CODE_SCAN_LIMIT`) and extracts the first OTP-shaped token;
  `query` narrows to subject/from/snippet matches, `maxAgeSeconds` drops stale
  mail and an explicit `pattern` overrides the default rule (group 1 is the code).
- The definitions' hard cap (`MAX_LIST_LIMIT` = 100) is applied on top of
  `maxListLimit`, so a caller can never exceed it.

## Invocation

The tools are reachable over the shipped tools seam - no new transport:

```console
$ curl -s -X POST http://127.0.0.1:8080/api/tools/email%20list \
    -H 'content-type: application/json' -d '{"account":"work","limit":3}'
{"status":"ok","tool":"email list","result":{"account":"work","count":3,"messages":[...]}}

$ curl -s -X POST http://127.0.0.1:8080/api/tool/call \
    -H 'content-type: application/json' -d '{"tool":"email code","params":{"account":"personal","maxAgeSeconds":900}}'
{"status":"ok","tool":"email code","result":{"account":"personal","code":"123456","subject":"Your sign-in code",...}}
```

Failures are the seam's structured errors, never a crash: `400` with
`{ error: { kind: "invalid-params", violations: [...] } }` when a body does not
satisfy the schema (e.g. `email get` without `id`, or `format: "pdf"`), `404`
`unknown-tool` when the plugin is not loaded, and a `500` whose body is
`{ status: "error", error: { kind: "tool-failed", message: "email: ..." } }` when
the capability itself refuses (not configured, unknown account, no code found);
the process keeps serving.

## Requirement

`email-tools` needs an `email@1` PROVIDER to be configured and enabled. With
`plugins.email-himalaya` missing or unconfigured, the tools stay registered and
answer with the capability's structured "not configured" error - which is the
correct, observable behaviour of a consumer that is provider-agnostic.

## Config row

```yaml
plugins:
  email-tools:
    defaultListLimit: 10
    maxListLimit: 50
```

No secret of any kind: the credentials belong to the provider.

## Test

`test/email-tools.test.ts` boots a kernel with a FAKE `email@1` provider (the
same Definition the real provider uses) and drives all four tools through
`POST /api/tools/<name>` and `POST /api/tool/call`, including the schema
violations and the default-account resolution; a second case swaps the provider
and shows the tools unchanged.
