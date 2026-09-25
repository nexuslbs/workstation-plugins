# totp-rfc6238 - the TOTP **provider** (`totp@1`)

External plugin for the workbench `totp@1` capability seam (core
`docs/PLUGIN-CONTRACT.md`, section 4f). It is the **Provider** role:

| Role | Where | What |
| --- | --- | --- |
| Definition | core `src/totp/definition.ts` (`ctx.totp`) | the contract: `entries()`, `code(label, { at })` |
| **Provider** | **this plugin** | RFC 4226/6238 TOTP over `node:crypto` HMAC |
| Consumer | `plugins/totp-tools` | the tools `totp list` / `totp code` |

It imports nothing from the core: it registers an implementation of the published
contract, and the manifest declaration is what makes that legal.

```json
"capabilities": [{ "id": "totp", "version": 1, "provider": "rfc6238" }]
```

## The algorithm (and only the algorithm)

- **RFC 4226** (HOTP), section 5.2: `HMAC(K, C)` with `C` the counter as an
  8-byte big-endian integer. Section 5.3, *dynamic truncation*:
  `offset = low 4 bits of the LAST digest byte`, `binary = the 31 bits starting
  at offset` (the high bit is masked off), `HOTP = binary mod 10^digits`.
  Section 5.4: `digits = 6` by default.
- **RFC 6238** (TOTP), section 4.2: the counter is `T = floor((now - T0) / X)`
  with `T0 = 0` (unix epoch) and `X` the period in seconds (default `30`).
  The hash is `SHA1` by default; `SHA256`/`SHA512` are supported (appendix B).

There is **no dependency**: `node:crypto` only (`createHmac`).

### Clock skew, truthfully

Section 4.2 notes a validator typically accepts the code of the *previous*,
*current* and *next* step (+/- 1 step). This plugin never shifts the clock: it
answers for exactly the second the caller names (default: now) and reports
`remainingSeconds` (how long that code stays valid, 1..`period`). A caller who
wants tolerance asks for `at = now - period` / `at = now + period` and compares
itself; nothing here silently rounds.

## Configuration

```yaml
plugins:
  totp-rfc6238:
    entries:
      github:
        secret: ${cred:TOTP_GITHUB_KEY}   # PREFERRED: a credential reference
        issuer: GitHub
        account: me@example.com
      aws-root:
        secret: JBSWY3DPEHPK3PXP          # a literal base32 key also works
        digits: 6
        period: 30
        algorithm: SHA1
      work-vpn:
        credential: TOTP_WORK_VPN         # a credential NAME resolved at CALL time
        issuer: Acme
        algorithm: SHA256
```

`secret` and `credential` are two spellings of the same thing:

- `secret: ${cred:NAME}` - the core expands the reference **before** `apply`, so
  a missing credential is a boot-time config error naming the reference.
- `credential: NAME` - resolved **at call time** through `ctx.credentials`, so a
  missing/empty credential keeps the plugin loaded and reports that **entry** as
  `configured: false`; only a call for that entry fails.
- `secret: <literal base32>` - convenient for a scratch key.

An entry with no key at all is valid too: it is reported as `configured: false`
and refuses to produce a code, while every other entry keeps working.

### Required credentials (names, never values)

| Credential name | Used by | Value |
| --- | --- | --- |
| `TOTP_GITHUB_KEY` | `entries.github` (dev config) | base32 key of the GitHub TOTP |
| `TOTP_AWS_ROOT_KEY` | `entries.aws-root` (dev config) | base32 key of the AWS root TOTP |

### Secrets: what this plugin guarantees

- A key value is never logged, never returned, never part of `entries()` or of
  `describe()`; only the generated code leaves the plugin.
- A diagnostic that must mention a key uses `maskSecret()` (first/last two
  characters, rest redacted), never the value.
- An undecodable key is reported as *not configured* with the offending
  character position, never with the key text.
- **Committing a real key is forbidden.** Use `${cred:NAME}` (or a `credential`
  name) and keep the value in the credentials store / an untracked file. The
  literal form exists for scratch keys only.

`apply()` never throws on missing optional configuration (contract rule 6): with
no `entries` the plugin loads, logs "not configured" and registers nothing; a
provider error is never reported under `failures`.

## Published test vectors (used by the unit test)

RFC 6238 appendix B, secret = ASCII `12345678901234567890`
(base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`):

| T (unix seconds) | SHA1 (8 digits) | 6 digits |
| --- | --- | --- |
| 59 | 94287082 | 287082 |
| 1111111109 | 07081804 | 081804 |
| 1111111111 | 14050471 | 050471 |
| 1234567890 | 89005924 | 005924 |
| 2000000000 | 69279037 | 279037 |
| 20000000000 | 65353130 | 353130 |

SHA256 (`12345678901234567890123456789012`) at T=59 -> `46119246`;
SHA512 (`1234567890123456789012345678901234567890123456789012345678901234`)
at T=59 -> `90693936`. Cross-checked against an independent implementation
(`oathtool --totp` / python `pyotp`) in the task's verification run.

## Tests

```sh
npm test      # from the workbench-plugins root
```

`test/totp-rfc6238.test.ts` covers base32 decoding (padding/space/invalid), the
RFC vectors above, the T=59/60 boundary (`remainingSeconds`), entry metadata
without a secret, the unknown-label and not-configured paths, and the
no-`entries` (loaded but not configured) path.
