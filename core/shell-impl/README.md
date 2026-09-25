# `shell-impl` - the `shell@1` provider `local-bash`

LOCAL execution. **This is the only transport of this repository that runs a
command on the workbench HOST**, which is why the manifest declares
`"execution": "host"` and the `policies.shell` row, and why `apply()` refuses to
load when that declaration is missing (`assertPolicyDeclared`).

## Contract

`shell@1` (`definitions/shell.ts`). Service name `ctx.shell`.

```ts
run(input: string, options?: { timeoutMs?, maxOutputBytes?, cwd?, env? })
  -> { output: string, code: number | null, stderr?: string, durationMs: number, truncated?: boolean }
create(config) -> instance bound to its own config
```

## Configuration (the `plugins: shell-impl:` row, or the `params` of a
`general-service` config of type `local`)

| key | default | meaning |
|---|---|---|
| `shell` | `bash` | `bash` / `sh` / `zsh` |
| `binary` | - | absolute shell binary; overrides `shell` |
| `cwd` | host process cwd | working directory |
| `timeoutMs` | 30000 | per-call timeout; the process is KILLED on expiry |
| `maxOutputBytes` | 4194304 | output cap (`truncated: true` when it bites) |
| `env` | - | extra environment for the child |

## Shell-safety

`planLocal(config, input)` builds `[<shell>, '-c', <input>]` and the provider
starts it with `execFile` (argv array, no host shell): the HOST shell evaluates
`input` exactly once, on purpose. Every other transport of this repository runs
the command inside its target instead - a `container`/`ssh`/`http` config never
reaches this provider.

## Credentials

None. This provider resolves no credential; a command that needs one must get it
from the caller (the caller resolves it through `ctx.credentials` and passes it
only through the call args, never through a committed file).

## Swapping the provider

Disable this plugin and enable another plugin declaring
`{ "id": "shell", "version": 1, "provider": "<other>" }`: a `general-service`
config of type `local` then resolves to that provider with no change to
`general-service-impl` (see `docs/SERVICES.md`, "Swapping a transport").

## Tests

`test/transports.test.ts` (type dispatch, quoting/piping, timeout, output cap)
and `test/shell-safety.test.ts` (the host marker probe).
