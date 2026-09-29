# tools-typed

Typed, model-facing TOOLS for the two highest-usage general tools of the
`workstation-tools` concern: `jq` and `python3`. Usage evidence from
2026-09-26..29 selected exactly these two (`python3` 1066 productive calls in
155 sessions, `jq` 27 calls in 4 sessions); everything else stays reachable
through the generic `container-exec` `<id>_exec` fallback.

The plugin is a **consumer**: it imports the `general-service@1` definition and
the shared `shellQuote` helper only. It learns no backend, no image and no host
path beyond the compose coordinates in its config, and it never touches a
credential.

## Tools

| Tool | Parameters (type) | Result |
| --- | --- | --- |
| `jq_query` | `filter` (`string`, **required**), `json?` (`string`, inline JSON, mutually exclusive with `file`), `file?` (`string`, a path inside the container; only `/opt/omni/**` is mounted read-only), `raw?` (`boolean`, adds `-r`), `slurp?` (`boolean`, adds `-s`), `compact?` (`boolean`, adds `-c`, default `true`) | `{ ok, service, code, result?, output, stderr?, durationMs, truncated? }` - `output` is the raw jq stdout, `result` is that stdout parsed as JSON when it is a single JSON value. |
| `python_run` | `code` (`string`, **required**), `stdin?` (`string`), `args?` (`array<string>`, becomes `sys.argv[1:]`), `cwd?` (`string`, inside the container), `timeoutMs?` (`integer`, default 60000, cap 600000) | `{ ok, service, code, stdout, stderr?, durationMs, truncated? }` - the raw stdout, stderr and exit code. |

Parameter semantics:

- `jq_query` takes **exactly one** input source: inline `json`, or a `file`
  visible inside the container. Passing both, or neither, is a typed
  `{ ok: false, error: "invalid-input" }` answer. `file` is read by the
  container's own `jq`, so the path must resolve **inside** `workstation-tools`
  (only the omni-root checkout `/opt/omni/**` is bind-mounted, read-only).
- `compact` is on unless the caller sets `compact: false`; `raw`/`slurp` map
  straight to `jq -r` / `jq -s`.
- `python_run` runs the source with `python3 -c`, so `args` land in
  `sys.argv[1:]`, `stdin` is piped in, and `cwd` prefixes `cd <dir> &&`.
- `timeoutMs` bounds that one call; the config `timeoutMs` is the default and
  the hard ceiling is 600000 ms for every call.

Every caller-supplied value is POSIX single-quoted with the shared `shellQuote`
helper before it reaches the shell; the boolean switches are the only unquoted
interpolations and their literals are chosen by the plugin, never by the caller.

## Transport

Both tools exec INSIDE the configured compose service through the
`general-service@1` **container** transport (docker-impl ->
`docker compose --project-directory /opt/omni exec -T workstation-tools sh -c
<command>`). The transport never falls back to the host: if no
`general-service@1` provider (or no docker-compose transport) is loaded, the
tools answer the typed `{ ok: false, error: "missing-service" }` body.

## Config row

```yaml
plugins:
  tools-typed:
    service: workstation-tools   # compose service to exec into
    projectDir: /opt/omni        # compose project directory
    timeoutMs: 60000             # default per-call bound, cap 600000
```

No secret of any kind: the plugin holds no credential; a DSN/password is a
call-time parameter or an `$env:VAR` / `${cred:NAME}` reference the caller
resolves.

## Test

`test/tools-typed.test.mjs` applies the plugin against a fake tool registry and
a fake `general-service`, then asserts the two registered names, their compiled
parameter types and required flags, the legal-name regex, the empty/malformed
config fallback, the shell-quoted command shapes (inline and file mode, flags,
cwd/stdin/args), and the typed invalid-input / missing-service bodies. It needs
no harness, no model call, no network and no container.
