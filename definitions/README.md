# `definitions/` - the service contracts of this repository

Workbench is an EXTERNAL host for these plugins: this repository is a plugin
source, not part of the core. The core hosts only a handful of capabilities
(`credentials`, `web`, `email`, `totp`, `sms`); everything the service/transport
stack of this repository needs is declared HERE, so the plugins that provide and
consume it can be developed, replaced and versioned without a core change.

## The three roles (unchanged from the core seam)

```
        provides                    consumes
Provider ---------> Definition <----------- Consumer
(core/*-impl)                    (plugins/*-tools, plugins/*-consumer)
```

* a **Definition** is a contract module: types, a versioned contract id, service
  lookup helpers and (when it is backend agnostic) shared algorithms;
* a **Provider** implements the contract and declares the capability in its
  `workbench.plugin.json` manifest, then registers its service;
* a **Consumer** only ever calls the service. It never imports a provider and a
  provider never imports a consumer (`test/seam.test.ts` enforces the direction
  INSIDE this repository too).

## The contracts

| contract | module | service | what it does |
|---|---|---|---|
| `shell@1` | `shell.ts` | `ctx.shell` | runs ONE command string through a LOCAL shell - the only host-executing transport |
| `ssh@1` | `ssh.ts` | `ctx.ssh` | runs ONE command string on a REMOTE machine |
| `docker@1` | `docker.ts` | `ctx.docker` | runs ONE command string INSIDE a container (compose capable) |
| `http@1` | `http.ts` | `ctx.http` | calls a URL with the input as the request body; no shell |
| `general-service@1` | `general-service.ts` | `ctx['general-service']` | ONE facade whose CONFIG (`type` + `params`) selects `shell`/`docker`/`ssh`/`ssh+docker`/`http` |
| `himalaya@1` | `himalaya.ts` | `ctx.himalaya` | typed mail-CLI actions (`accounts`, `folders`, `envelopeList`, `messageRead`, `run`) |
| `email@1` | `email.ts` | `ctx.mail` | the generic email capability (`accounts`, `list`, `get`, `code`, `search`, `send`) |
| `web@1` | `web.ts` | `ctx.web` | the web seam (routes / assets / pages) served by the provider plugin `core/web-impl`; moved here from the CORE in v0.0.3 |
| `fs@1` | `fs.ts` | `ctx.fs` | the filesystem capability (stat / read / write / append / edit / list / glob / grep) served by a provider plugin (`core/fs-local` today); reads unrestricted, writes confined to the provider roots |

## Why a definition per transport AND a `general-service`

The operator's rule (telegram thread 2440): the transports are SERVICES with
their own definitions, so a better implementation can replace one later (a native
SSH library instead of the `ssh` binary, a docker API client instead of the
`docker compose` CLI). `general-service@1` is the single entry point a consumer
uses: it does not hard-inject any transport, it resolves the one its CONFIG names
at call time, and an unsupported or not-loaded transport is a structured error -
never a silent fall back to another transport (and never to the host).

## Shell-safety invariant (mandatory)

For every type except `local` the command string must run INSIDE the target
(container / remote machine / remote container). Each Definition documents its
exact launcher argv; each provider builds that argv as a PURE function
(`planLocal`, `planSsh`, `planContainer`, `planLocal`/`planRemoteDocker`) so the
argv is asserted by tests and shown as safety evidence, and every value that
reaches a shell goes through `shellQuote` (POSIX single quoting) or is handed to
`execFile` as ONE argv element (never through a host shell).

`local` is the ONLY type that executes on the workbench host, and the plugin that
provides it declares `"execution": "host"` in its manifest plus the policy that
requires the provider contract (`assertPolicyDeclared` in `support.ts` verifies
that declaration at `apply()` time).

## Load ordering ("load after", never "require")

`waitForServices(ctx, names, { timeoutMs })` (support.ts) is the SOFT, BOUNDED
ordering hint: it resolves as soon as every named service is loaded, or when the
bound expires, reporting the missing ones - it never throws and never hangs. A
plugin still loads when a service it can use never loads at all; only the configs
that NEED it fail, with an error naming the missing service.

## Configuration

The transport a service uses is a CONFIG VALUE, never code: see
`docs/SERVICES.md` and each plugin README. Credentials are referenced BY NAME
(`${cred:NAME}` / `credential: NAME`) and resolved at call time through
`ctx.credentials`; no value is ever committed, logged or reported.
