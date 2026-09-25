# `general-service-impl` - the `general-service@1` provider `config-dispatch`

ONE service, five transports, chosen by CONFIG. This is the answer to "no plugin
per transport": the transports are separate services (their own Definitions,
their own providers, replaceable), and this provider is the single facade a
consumer uses.

## Contract

`general-service@1` (`definitions/general-service.ts`). Service name
`ctx['general-service']`.

```ts
create({ type, params }) -> instance            // validates NOW (fail-to-load)
instance.call(input: string, options?) -> { output, code, stderr?, durationMs, type, truncated?, status?, headers? }
call(input, config, options?)                   // one-shot convenience
```

## The config -> service map

| `type` | service | where the command runs |
|---|---|---|
| `local` | `ctx.shell` | the workbench HOST (the only host type; see `shell-impl`) |
| `container` | `ctx.docker` | inside the container (`docker compose exec ... sh -c`) |
| `ssh` | `ctx.ssh` | on the remote machine |
| `ssh+container` | `ctx.ssh` + `ctx.docker` | inside a container ON the remote machine |
| `http` | `ctx.http` | no shell at all: the input is the request BODY |

`params` are the Definition's own params of that type; `ssh+container` takes
`{ ssh: {...}, container: {...} }`.

## No hard injection (the operator's rule)

The plugin declares `inject: []` and NONE of the transports: it resolves the
service the config names through the non-strict, config-driven lookup
(`ctx.get(name, false)`) at call time. Therefore:

* a config of type `ssh` works while NO docker/container service is loaded (and
  the other way round);
* an UNRELATED transport being absent is never an error;
* the type that IS needed must be loaded: `create()` throws
  `missing-service` (naming the service, e.g. `docker`) BEFORE any command runs,
  and an unknown `type` throws `unsupported-type`. There is no fallback to
  another transport and none to the host.

The instance API is what a consumer such as `himalaya-impl` uses: it binds its
config once, at load, so a deployment whose transport is missing fails at LOAD
with a named error instead of failing on every call.

## Load ordering ("load after", never "require")

`apply()` waits (SOFT and BOUNDED, `loadAfterTimeoutMs`, default 500 ms) for the
transports it COULD use before providing its service, so a transport that loads
slowly cannot race the dispatch. The wait never throws and never hangs: the
missing transports are logged, the plugin still loads, and only the configs that
need them fail - naming the missing service.

## Shell-safety

The provider owns no argv of its own: it hands the caller's command string to the
transport, and EVERY transport of this repository evaluates it inside its target
(`container`, `ssh`, `ssh+container`) or not at all (`http`). `ssh+container`
assembles the docker launcher as a string (pure `planRemoteDocker`) and gives it
to the ssh service, so the remote shell is the only evaluator and the workbench
host never sees the command.

## Swapping a transport

Point the config at another provider for the same contract: disable
`core/docker-impl` and enable another plugin declaring
`{ "id": "docker", "version": 1, "provider": "<other>" }`. Nothing changes here -
the swap is a config edit (see `docs/SERVICES.md`).

## Tests

`test/transports.test.ts` (the full matrix through this service),
`test/general-service.test.ts` (type dispatch without a service -> named error,
no host command ran, bounded load-after).
