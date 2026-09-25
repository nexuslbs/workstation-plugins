# `docker-impl` - the `docker@1` provider `docker-compose-cli`

CONTAINER execution: the command string runs INSIDE the container only.

## Contract

`docker@1` (`definitions/docker.ts`). Service name `ctx.docker`.

```ts
run(input: string, options?: { timeoutMs?, maxOutputBytes? })
  -> { output, code, stderr?, durationMs, truncated? }
create(config) -> instance bound to its own config
```

## Configuration

| engine | keys |
|---|---|
| `docker-compose` (default) | `compose: { project_dir (required), service (required), file?, env_file?, project_name?, profile? }` |
| `docker` | `container` (exec into it) or `image` (run it), plus `entrypoint?`, `network?`, `mounts?` |

Common: `binary` (default `docker`), `timeoutMs` (default 60000), `maxOutputBytes`
(default 4194304).

`project_dir` is the compose `--project-directory`; when `env_file` is omitted,
docker compose falls back to `<project_dir>/.env` (its own behaviour), so a
deployment that keeps its `.env` next to the compose file needs no extra key.

## The launcher (shell-safety)

`planContainer(config, input)` (pure, exported by the Definition) builds

```
docker compose --project-directory <dir> [-p <proj>] [-f <file>] [--env-file <env>]
  [--profile <p>] exec -T <service> sh -c <input>
```

`execFile` starts that argv directly: the workbench host shell never sees
`input`; the CONTAINER's `sh -c` is the only thing that evaluates pipes,
redirections, quotes, globs and `$`. `planRemoteDocker` produces the same argv as
ONE remote command string, which is what the `ssh+container` type of
`general-service@1` hands to `ctx.ssh`.

Target trouble (daemon down, unknown service/image, not running) is reported as
`unreachable`; a non-zero exit is reported as a structured `non-zero-exit` by the
general service. The command NEVER runs on the host.

## Credentials

None (the provider resolves no credential). The container gets its own
environment from compose (`env_file`), which the operator controls.

## Swapping the provider

Disable this plugin and enable another plugin declaring
`{ "id": "docker", "version": 1, "provider": "<other>" }` (e.g. a docker API
client): a `general-service` config of type `container` resolves to it with no
change to `general-service-impl`.

## Tests

`test/transports.test.ts` runs a real throwaway container (`alpine`/`busybox`
image if present, otherwise the omni `toolbox` service) through the type dispatch
of `general-service`, including the piped/redirected command and the host-marker
safety probe.
