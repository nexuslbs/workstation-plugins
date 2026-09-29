# workspace-register-allroots (LIVE-MOUNT staging copy)

This directory is a **staging copy** of `plugins/workspace-register/`, created so the
running service can load the new all-roots backfill code without a restart.

## Why a separate directory

The harness module loader caches an ES module by its **resolved URL**. A plugin is
mounted from a URL; re-mounting the same path (even with a `?rev=` query) re-imports
its entry module, but that entry's relative import `./registration.ts` still resolves
to the **same already-cached URL**, so the old `registration.ts` keeps running.

Copying the plugin into a new directory makes `index.ts` resolve `./registration.ts`
to a **new URL**, which forces Node to build a fresh module graph and pick up the
current `registration.ts` (one workspace per distinct canonical cwd root).

* Files here are copies of the canonical code: `index.ts`, `registration.ts`,
  `workbench.plugin.json`.
* `index.ts` deliberately keeps its relative import `./registration.ts`; inside this
  directory that resolves to this directory's `registration.ts`.

## Canonical code stays in plugins/workspace-register/

`plugins/workspace-register/` is the source of truth. This staging copy exists only
for the live-mount cutover; edit the canonical plugin, then refresh these copies.
