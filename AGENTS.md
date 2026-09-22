# AGENTS.md

Developer notes for Wrangler² — the Agent Wrangler automated-jobs system as an
installable extension. Only the non-obvious, durable things; point at code rather
than re-deriving it. **Read `docs/PORTING.md` first**: the port is functionally
complete on host API 1.8.0, and that file is the map (what came from where, what
stands in for what, and which of the six open host-API gaps block which
feature).

## What this is

- An **external extension** for agent-wrangler's extensions API, which is on
  agent-wrangler `main` (host API 1.8.0). Spec:
  `docs/superpowers/specs/2026-09-11-extensions-api-design.md` in that repo.
- The wrangler clones this repo into `<DATA_DIR>/extensions/jobs/`, runs
  `npm ci --ignore-scripts`, and imports `index.js`. **The manifest `id` (`jobs`)
  MUST equal that directory name** or the asset route, provenance record and
  uninstall path disagree. `package.json`'s `wranglerExtension` block is what the
  human consents to BEFORE any code runs, so it and `server/manifest.js` are
  duplicated by design and must agree (`id`, and `requires` in the manifest may
  not be WIDER than the block's). `requires` is the four `sessions:*` (read, spawn,
  archive, bill) plus `usage:read` and `board:rebuild`/`board:broadcast` —
  **not** `tasks:write`: spawn's `taskId` binds task memory and assigns the card
  itself, and it is documented as not an escalation. `engines.wranglerApi` is
  `^1.8.0`: 1.4 added the worktree/`addDirs`/`taskId`/PR-automation spawn
  options this repo depends on, 1.6 the `usage:read`/`sessions:bill` pair the
  Jobs board's prices and triage billing depend on, 1.8 the client
  `api.openSession(sid)` behind the sub-job dialog's Open/Restore session button
  (there is no `sessions:wake` any more: the board resumes the card itself), and
  1.7 the `view` `badge()` core draws the needs-you count from.
- **`package-lock.json` is mandatory** — the wrangler refuses to install without
  one. Regenerate it after any dependency change.

## Invariants & footguns

- **Nothing here may import agent-wrangler.** The extension runs in the wrangler's
  process but reaches it ONLY through the per-extension `host` façade it is handed
  (`host.sessions.*`, `host.rebuild()`, `host.broadcast()`,
  `host.stores.jobs`, `host.log`). Anything the façade lacks is a
  `TODO(host-api …)` comment at the call site AND a row in `docs/PORTING.md`.
  `grep -rn 'TODO(host-api' server public` is the live list.
- **No own file may have an import line matching `from '../index.js'`, or any
  path ending `/session-manager.js`, `/state-reader.js`, `/tmux-scraper.js`, or
  containing `/host-api/`.** The wrangler's leaf-import scanner
  (`server/extensions/external.js` `FORBIDDEN_IMPORTS`) quarantines the WHOLE
  extension on a match — tests included, since it scans every `.js` outside
  `node_modules`. That is why the manifest lives in `server/manifest.js` and the
  root `index.js` only re-exports it: a test imports the manifest from
  `./manifest.js`, never `../index.js`.
- **Extension signatures differ from core's.** An MCP tool is
  `handler({ host, caller }, args)` (no `deps`); a control handler is
  `handler(msg, host)` (no `ctx`, so **no `ctx.reply`** — the only outbound
  channel is `host.broadcast(payload)`, whose `type` is forced to `ext:jobs`).
  The client's `api.send` is bound to THIS extension's handler types only; a frame
  of any other type (a core `resume`, say) is dropped browser-side.
- **The runner is a per-process singleton built lazily from the first façade it
  sees** (`server/jobs.js` `runnerFor`). A store factory gets
  `{ id, extId, settings, log }` and no façade, so the runner cannot be built
  where the store is; every tool/handler/sweep is
  handed the same façade object, so building on first use is safe. The per-card
  spend refresh (`spendFor`) is a singleton for the same reason.
- **The graph contributor never awaits the usage read.** `host.usage.byCard()`
  walks every transcript on disk, so `server/job-spend-refresh.js` serves the map
  the last 60s refresh produced and only KICKS the next one; the first graph
  after boot carries no price by design.
- **`onBeforeDispatch` ↔ launch correlation is positional** (`pendingLaunch`,
  `server/job-runtime.js`). The hook fires inside `host.sessions.spawn()` with the
  card id but no tag saying which spawn it belongs to; one launch at a time
  (the runner's `busy` guard) is what makes the single pending slot correct.
  Don't add a second concurrent spawn path without a real tag.
- **The WRANGLER cuts a job's worktree**, not this extension:
  `spawn({ worktree: { branch, base, auto } })` (host API 1.4) stamps
  `entry.worktree` and returns the record, `onBeforeDispatch` carries it too, and
  `server/job-runtime.js` only picks the base and merges its own `cleanupHead`
  onto the record (nothing the host returns carries the commit a branch was cut
  from, and cleanup's compare-and-delete needs it). So core's `name_branch`
  applies to a job session and prompts and the skill must name it. There is no
  rename hook, so `sub.worktree.branch` is kept in step by READING
  `host.sessions.get(caller).worktree.branch` back in `server/tools.js`
  (`syncBranch`, on both tools) and calling `noteBranchRename`. Every LATER
  phase (publish, repair, retry) spawns with `cwd: existing.repoRoot` and
  `worktree: { branch, folderName: existing.path, auto: false }`: spawn has no
  adopt option, but the wrangler's `createWorktree` classifies that pair as
  `adopt` and stamps the record, which is what lets `name_branch` work on the
  publish run (the one that pushes). `noteDispatch` discards the adopted record
  (`pendingLaunch.adopt`) so the store's copy keeps its `cleanupHead` and rename.
- **Client modules import their leaves RELATIVELY** (`./util.js`, `./icons.js`,
  vendored) rather than from the board by absolute URL, so the same files load
  under node for `public/*.test.js`. Don't switch them to `/util.js`.
- **The `<dialog>` is appended to `<body>`, not to the view host**: a dialog under
  a `display:none` ancestor cannot `showModal()`, and the host is hidden whenever
  another view is active.
- Same house rules as agent-wrangler: no unnecessary comments, dense "explain
  *why*" style; front-end colour only through the board's semantic CSS variables
  (`var(--bg)`, `var(--fg-muted)`, …) so it works in dark and light; agent-written
  text (briefs, receipts, comments) is escaped or `textContent`, never raw
  `innerHTML`.

## Commands

- `npm test` — `node --test` over `server/*.test.js` and `public/*.test.js`, with
  `test-setup.js` redirecting `AW_DATA_DIR` so no test touches
  `~/.agent-wrangler/jobs.json`. `server/test-helpers.js` holds the one fake host
  every server suite builds on; it is not `*.test.js`, so the glob does not run
  it as an empty suite. One test (`server/integration.test.js`) runs the real
  loader's `validateManifest` and SKIPS unless `AW_REPO` is set (see
  `docs/PORTING.md`, "Tests").
- Dev install without git: **copy** (never symlink — discovery only sees real
  directories) this checkout, `node_modules` included, to
  `<AW_DATA_DIR>/extensions/jobs` of a run-dev wrangler instance and restart it
  (a hand-dropped directory loads with no provenance record and no consent gate).
- `AW_REPO=<wrangler checkout on the API branch> node scripts/validate-manifest.mjs`
  runs the real loader over this repo: discovery + import scan, `validateManifest`,
  `loadExtensions` with the core tool/handler names, `buildHostApi`.
