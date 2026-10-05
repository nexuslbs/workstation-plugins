# ssh-tools

An **external consumer** of the `ssh@1` capability: it registers the
model-facing tools `ssh_run`, `ssh_status`, `ssh_copy_to` and `ssh_copy_from`
through `ctx.tools.register(defineTool({...}))` and resolves the transport per
call as `ctx.ssh` (never by importing a provider).

## Prior art mapping

The omniagent Rust MCP plugin
(`/opt/workspace/omniagent/plugins/tools/ssh/`, names `run`/`copy`/`status`)
maps onto these four tools:

| omniagent tool | dsh tool here | built on |
| --- | --- | --- |
| `ssh_run` | `ssh_run` | `SshInstance.run` (contract `planSsh`) |
| `ssh_copy` to-remote | `ssh_copy_to` | `run` with a base64 command |
| `ssh_copy` from-remote | `ssh_copy_from` | `run` with a base64 command |
| `ssh_status` | `ssh_status` | `run('true')` + latency |
| `ssh_key_secret_name` | `credential` (credential NAME) | `SshConfig.privateKeyName` |

## Tools

| tool | parameters | answers |
| --- | --- | --- |
| `ssh_run` | `host` (required), `command` (required), `credential?`, `timeoutMs?` | `{ host, code, output, stderr?, durationMs, truncated? }` |
| `ssh_status` | `host` (required), `credential?`, `timeoutMs?` | `{ host?, reachable, code?, durationMs, stderr? }` or, on failure, `{ reachable: false, reason, error?, stage? }`. NEVER throws |
| `ssh_copy_to` | `host` (required), `localPath` (required), `remotePath` (required), `credential?`, `timeoutMs?` | `{ direction: "to-remote", bytes, code, durationMs, ... }` |
| `ssh_copy_from` | `host` (required), `remotePath` (required), `localPath` (required), `credential?`, `timeoutMs?` | `{ direction: "from-remote", bytes, code, durationMs, ... }` |

Model-facing names satisfy `^[a-zA-Z0-9_-]+$` (never a space); a regression is
also pinned by the cross-plugin test `tests/worker-facing-tool-names.test.mjs`.

## No invented host

`host` is a REQUIRED tool parameter in the portable `[user@]host[:port]` form.
The plugin never bakes in or guesses a target. The identity is an optional
`credential` parameter (a credential NAME) that defaults to the consumer config's
`privateKeyName`; the ssh config file comes from the config and defaults to
`/opt/omni/data/ssh/config`.

## Copy bound

`ssh@1` has only `run`, so a file travels as base64 inside the ONE remote command
string: `printf %s '<b64>' | base64 -d > <path>` to-remote and
`base64 -w0 < <path>` from-remote. base64 expands the payload 4/3 and the encoded
text must fit in one argv element (Linux `MAX_ARG_STRLEN`, 128 KiB), so the
transfer bound defaults to 48 KiB and is hard-capped at 64 KiB. A larger file is
REJECTED with a structured `invalid-input` naming the bound, never silently
truncated. `ssh_copy_from` also rejects a truncated or non-base64 remote answer
with `malformed-output`.

## Config row

```yaml
plugins:
  ssh-tools:
    privateKeyName: SSH_PRIVATE_KEY          # credential NAME, never a value
    configFilePath: /opt/omni/data/ssh/config
    timeoutMs: 30000
    maxOutputBytes: 4194304
    maxCopyBytes: 49152
```

## Test

`test/ssh-tools.test.mjs` runs the consumer against a fake tool registry and a
fake `ssh` service (no harness, no network, no credential) and pins the names,
the parameter shapes, the per-call bind, the base64 commands and the size bound.
`test/ssh-impl.test.mjs` covers the provider seams.
