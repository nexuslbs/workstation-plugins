# `himalaya-impl` - the `himalaya@1` provider `cli`

Typed mail actions on top of the himalaya CLI, executed **through the general
service**. This plugin owns no transport: the config row says where himalaya
runs, and `general-service-impl` dispatches to the transport service of that
type (`shell` / `docker` / `ssh` / `ssh+docker` / `http`).

## Why

himalaya v1.2.0 lives in the omni **toolbox image**, not on the workbench
runtime PATH. Instead of shipping one plugin per way of reaching it, ONE
provider builds an argv string and ONE general service runs it wherever the
config says - a container of the current stack, a remote machine, or a local
binary.

## Config

```yaml
plugins:
  himalaya-impl:
    general:
      type: container
      params:
        engine: docker-compose
        compose:
          project_dir: ${env:OMNI_DIR}
          service: toolbox
          # env_file defaults to <project_dir>/.env (docker compose behaviour)
```

Nothing else: no account, no image, no host, no path of this repo's own. In the
stack the row lives in the omni-root `config/workbench.yml`; in the plugins repo
it is in `config.yml` for development.

## How a call becomes a command

| `himalaya@1` action | argv sent to the general service |
|---|---|
| `accounts()` | `account list -o json` |
| `folders({account})` | `-a <account> folder list -o json` |
| `envelopeList({account, folder, pageSize, query})` | `-a <account> envelope list -o json --page-size <n> [<folder>] [<query>]` |
| `messageRead({account, id, folder, noHeaders})` | `-a <account> message read -o json [--no-headers] [--folder <folder>] <id>` |
| `run({args, account})` | `<args>` (escape hatch, still typed-built by the caller) |

Every piece is single-quoted (`shellQuote`), so spaces, quotes and `$` in a
search query survive. The himalaya quirks are honoured here because they are the
CLI's, not the Definition's: `-o json` (never `--json`), **options before the
positional query**, and `message read -o json` answering a JSON *string* (the
parser unwraps it; a plain-text answer is returned as-is rather than failing).

A malformed answer throws a structured `malformed-output` error carrying a
200-char sample - never a crash.

## Not configured

With no `general` row the plugin still LOADS, logs the reason, and provides a
service whose every call answers a structured `not-configured` error. It never
appears under `failures`. The same is true when the general service itself is
absent (`missing-service`), and when the configured transport service is not
loaded yet.

### Load order: validated at load, bound per call (SOFT, never a dependency)

The core loader is SEQUENTIAL and walks the plugin directories of a source in
SORTED order, so a transport provider whose directory sorts after this one
(`shell-impl`, `ssh-impl`) is simply not loaded yet when `apply()` runs - even
though the config row is correct. Therefore:

1. the transport is validated AT LOAD: `general.create(<config>)` is called once,
   so a wrong type or a genuinely missing capability is reported immediately with
   the named error (`the config type 'local' needs the 'shell' service, which is
   not loaded (enable a plugin providing shell@1)`);
2. that first failure is NOT fatal: the instance is re-created on the next call,
   so a provider that loads milliseconds later is picked up and the first call
   after it succeeds;
3. a capability that stays missing keeps failing with the SAME named error - the
   plugin never lands under `failures`, never falls back to another transport and
   never runs on the host (`local`/`shell` is the only host transport, and it has
   to be the transport named in the config).

`createLateBinding()` in `index.ts` implements this; `test/himalaya-impl.test.ts`
covers it (the load-time error is kept, the next call binds, no fallback).

## Credentials

None here. himalaya's own account config (inside the container / on the remote
host) pulls the password at run time from the deployment's secret store; this
plugin never sees a mail password.
