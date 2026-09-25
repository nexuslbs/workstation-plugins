# email-himalaya

An **external provider** of the workbench email capability (`email@1`): it
implements the contract on top of the [himalaya](https://github.com/pimalaya/himalaya)
mail CLI, so a consumer (`plugins/email-tools`) can list messages, read one and
extract a verification code from a real mailbox.

Nothing here is part of the core: the core's `docs/PLUGIN-CONTRACT.md`
section **4e** defines the contract, this plugin implements it, and the manifest
declaration is what makes `ctx.email.register()` legal:

```json
{ "name": "email-himalaya", "entry": "index.ts",
  "capabilities": [{ "id": "email", "version": 1, "provider": "himalaya" }] }
```

## Prerequisite: himalaya itself

The plugin SHELLS OUT to the CLI (one process per call) instead of linking
himalaya's Rust libraries - trade-off: no protocol code and no credential store
here, at the price of a process per call and a dependency on the INSTALLED
himalaya version (this driver targets **himalaya v1.x**; see "Version" below).

- Install: `cargo install himalaya` (or the release binary of your platform) and
  make sure `himalaya --version` works for the user the workbench service runs
  as. Set `plugins.email-himalaya.binary` to an absolute path when it is not on
  PATH.
- Configure each mailbox **with himalaya's own tooling**
  (`himalaya account configure <name>`), which writes himalaya's `config.toml`
  (IMAP/SMTP or JMAP server, port, encryption, login).
- `accountName` below is the name you gave himalaya; when a `credential` name is
  configured, its VALUE is resolved through `ctx.credentials` at call time and
  handed to the child process in the `HIMALAYA_PASSWORD` environment variable -
  never on the command line and never in a log.

In a container, add the CLI to the image; the plugin needs no network of its own.

## Config row

```yaml
plugins:
  email-himalaya:
    defaultAccount: personal          # the operator's "default email"
    accounts:
      personal:
        address: me@example.com
        accountName: personal         # himalaya account name (its config.toml)
        folder: INBOX
        credential: EMAIL_PERSONAL_PASSWORD   # NAME only; ${cred:EMAIL_PERSONAL_PASSWORD} exists in the credentials store
      work:
        address: me@work.example
        accountName: work
```

- **Secrets are references**: `credential` holds a credential NAME. Never inline
  a value, and never commit a resolved value. The dev config keeps it as a plain
  string on purpose: an unresolved `${cred:NAME}` in the plugin config is a config
  error, while the plugin resolves the name lazily, only for a call that needs it.
- **Multiple accounts**: the account label is the method parameter that selects
  the mailbox (`email list --account work`); an omitted label means
  `defaultAccount` (or the first configured account).
- A `defaultAccount` naming an unknown label is logged and replaced by the first
  configured account (it never fails the load).

## States

| State | Behaviour |
| --- | --- |
| no `accounts` configured | NOT CONFIGURED: logs the reason, registers nothing. The capability reports "not configured" and no call crashes. |
| accounts configured, `himalaya` missing | The provider IS registered (its accounts come from the config) and every call that needs the CLI fails with a structured `email: the mail CLI 'himalaya' was not found ...` error. Not a load failure. |
| CLI fails / times out / unparseable JSON | a structured `email: 'himalaya ...' failed: ...` / `... unparseable ...` error; bounded by `timeoutMs` and `maxOutputBytes`. |

## Contract surface

Implements `accounts()`, `list(ref?, {folder?, limit?, unreadOnly?, since?})` and
`get(ref, id, {format?})`. It does NOT implement `code()` or `search()`: the
core definition implements both on top of the three required methods (it reads
the newest messages and extracts the code with the configured pattern), which
keeps the verification-code rule in ONE place instead of in every provider.

`list` maps onto `himalaya envelope list --account <name> --folder <folder>
--page-size <n> --output json`; `unreadOnly`/`since` are applied client-side,
so the driver asks for a larger page (`limit * 4`, capped at 200) and trims.
`get` maps onto `himalaya message read <id> --account <name> --output json`
(`--raw` for `format: raw`). Envelope/message JSON is normalised tolerantly
(arrays or `{envelopes: [...]}`, `{name, addr}` or `"Name <addr>"`, `Seen`
flag = read); `markdown` falls back to the text body.

## Version

Targets himalaya **v1.x** (the `envelope list` / `message read --output json`
shape). A release that moves a field is absorbed by the normaliser; a release
that drops `--output json` surfaces as a structured "unparseable ..." error
rather than a crash.

## Test

`test/email-himalaya.test.ts` runs the driver against a STUB `himalaya`
executable (a Node script printing the v1 JSON fixtures) - no mailbox, no
network, no CLI installation needed - plus the not-configured and
missing-binary paths.
