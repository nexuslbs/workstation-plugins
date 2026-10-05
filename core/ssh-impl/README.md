# ssh-impl

An **external provider** of the `ssh@1` capability (provider id `ssh-cli`): it
runs ONE command string on a REMOTE machine through the OpenSSH client, so a
consumer (`plugins/ssh-tools`, or `general-service@1` with a type `ssh` /
`ssh+container` config) can reach another host without any host-side shell.

The contract lives in `definitions/ssh.ts`; this plugin implements it and
declares the capability in `workbench.plugin.json`:

```json
{ "name": "ssh-impl", "entry": "index.ts", "execution": "remote",
  "capabilities": [{ "id": "ssh", "version": 1, "provider": "ssh-cli" }],
  "policies": { "ssh": { "provide": "ssh@1", "require": "ssh@1" } } }
```

`"execution": "remote"` is mandatory: `apply()` verifies it through
`assertPolicyDeclared`, so an undeclared host-reaching plugin does not load.

## Prerequisite

An `ssh` client on PATH of the workbench process (OpenSSH is the tested one:
`ssh -V` -> `OpenSSH_9.2p1`). No ssh server, agent or key file is required here:
the target and the identity are per-call config.

## Config row

```yaml
plugins:
  ssh-impl:
    host: root@example.internal:22        # portable [user@]host[:port]
    privateKeyName: SSH_PRIVATE_KEY       # a credential NAME, never a value
    configFilePath: /opt/omni/data/ssh/config
    timeoutMs: 30000
    maxOutputBytes: 4194304
```

- **A row without `host` is legal.** `apply()` does not validate its own config:
  the plugin loads and `ctx.ssh.run(...)` answers a structured `invalid-config`
  per call. This is what lets a capability layer mount the provider before a
  target is known.
- **`privateKeyName` is a NAME, never a value.** At call time the provider calls
  `ctx.credentials.resolve({ name })` (the same seam as
  `core/email-himalaya/index.ts:193` and `core/totp-rfc6238/index.ts:465`),
  writes the VALUE into a fresh 0600 file inside a 0700 `mkdtemp` directory,
  passes `-i <path>` plus `-o IdentitiesOnly=yes`, and removes the directory in a
  `finally` block on every return path (success, non-zero exit, timeout). The
  value is never logged, never stored beyond the call and never placed in a
  config.
- A credential that is missing, empty, or cannot be resolved is a structured
  error NAMING the credential (`missing-service` / `not-configured`, stage
  `ssh.credentials`). The provider NEVER falls back to an unauthenticated
  attempt.

## Instance seam

`create(config)` binds a target per call (`general-service@1` calls it when it
binds a type `ssh` config; `plugins/ssh-tools` calls it for every tool call).
Unlike the row config, `create` validates immediately, so a config naming an
unusable target fails before any command runs. `run(input, options)` returns the
shared `CommandResult` (`output`, `code`, `stderr`, `durationMs`, optional
`truncated`); transport failures are structured `ServiceError`s
(`invalid-config`, `not-configured`, `missing-service`, `spawn-failed`,
`timeout`) naming their stage.

## Shell safety

`planSsh` from the contract builds ONE argv array:

```
ssh [-F <cfg>] [-p <port>] [-i <key>] [-o IdentitiesOnly=yes] <options...> <target> "sh -c '<input>'"
```

The runner is `execFile` with that array (`lib/process.ts`): no host shell, no
`shell: true`, no host-side `sh -c`. The command string is evaluated once, by the
REMOTE shell, inside the single last argv element. An unreachable host makes ssh
exit non-zero (typically 255) and the command never runs locally.

## Test

`plugins/ssh-tools/test/ssh-impl.test.mjs` exercises the provider against a fake
child runner and a fake credentials capability: argv shape, no-shell/no-key-value
invariants, the 0600 temp key lifecycle, the missing-credential error, and the
per-call validation of a row config without a host.
