# task-board plugin

A file-backed, bounded task board shared across SEPARATE dsh worker processes:
the worker<->worker and worker<->orchestrator hand-off seam.

The workstation `jobs` service is an in-memory, session-scoped handle, so it
cannot be shared between workers. This plugin persists ONE JSON document on disk
and registers five model-facing tools.

## Tools

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `task_board_post` | `title`, `objective`, `assignee_role`, `evidence_required` (all required), `project?`, `timeoutSecs?` | create an `open` entry for a peer role, or `*` for any role |
| `task_board_list` | `assignee_role?`, `status?`, `limit?` | the entries visible to the CALLER role, oldest first, with status and claimant |
| `task_board_claim` | `id` | claim an `open` entry for the caller role (assignee must match or be `*`) |
| `task_board_complete` | `id`, `evidence`, `artifact` (all required, non-empty) | the EVIDENCE CONTRACT: refuses to settle without BOTH |
| `task_board_get` | `id` | one visible entry, including its evidence and artifact |

All names match `^[a-zA-Z0-9_-]+$` (the model provider rejects anything else).

## Config

```yaml
- insert:
    - id: task-board
      name: '/var/lib/workstation/sources/workstation-plugins/plugins/task-board/index.ts'
      config:
        role: developer            # THIS worker's own role (per profile)
        orchestratorRoles:         # roles that see every entry (default)
          - orchestrator
          - researcher
        maxEntries: 100            # default 100
        # queuePath: /var/lib/workstation/task-board/board.json
```

* `role`: the caller's own role. Visibility is role-scoped (see below).
* `orchestratorRoles`: default `['orchestrator', 'researcher']`.
* `maxEntries`: default `100`.
* `queuePath`: default `<dataDir>/board.json`; `dataDir` defaults to
  `$DSH_HOME/task-board` (so the exact default is
  `/var/lib/workstation/task-board/board.json`). It is always outside every
  repository working tree. `WORKSTATION_TASK_BOARD_DIR` overrides `dataDir`.

## Role scoping

An entry is visible to a caller if and only if one of these holds:

* `caller.role === entry.assignee_role`
* `entry.assignee_role === '*'`
* `caller.role === entry.from_role` (the poster can always follow up)
* `caller.role` is in `orchestratorRoles`

## Bounded queue (deterministic overflow policy)

When a post would exceed `maxEntries`, the plugin EVICTS the oldest SETTLED
entry: the completed entry with the smallest `completed_at`, ties broken by the
smaller `seq`. If the board is full and no entry is settled, the post is
REJECTED with `task-board: queue is full (maxEntries=...) and no settled entry
can be evicted; post rejected`.

## Storage and concurrency

Every write goes to a temp file in the same directory and is moved into place
with `rename(2)`, so a reader never sees a half-written document. A
read-modify-write sequence holds an advisory lock file (`<queuePath>.lock`); a
lock older than 10 seconds is treated as stale and reclaimed. Reads are
lock-free because the rename is atomic.

## Test

```sh
node --test plugins/task-board/test/task-board.test.mjs
```
