# Porting the job system onto the extensions API

This repo is the automated-jobs system from agent-wrangler's `job-system` branch
(18 commits ahead of `main`, never merged), re-homed as an **installable
extension**. The port is functionally complete against host API **1.6.0**: every
feature the in-core system had is either wired through the `host` façade or is
one of the six open gaps below. This document stays the map — what came from
where, what stands in for what, and what has to change in agent-wrangler before
a gap closes.

`grep -rn 'TODO(host-api' server public` is the live list; every marker it
returns has a row in "Host API gaps", and every row but 15 has a marker (see the
note under the table).

## Where the API is

Everything is on agent-wrangler `main` — no branches to chase any more.

| thing | where |
|---|---|
| Loader / manifest validation | `server/extensions/index.js` (`validateManifest`, `loadExtensions`, `CAPABILITIES`, `SESSION_HOOKS`, the settings defs) |
| The façade an extension is handed | `server/host-api/v1.js` (`V1_BUILDERS`), `server/host-api/project.js` (what a session/task looks like to us), `server/host-api/version.js` (what each minor added, and why) |
| Install flow, `wranglerExtension` block, lockfile rule | `server/extensions/install.js` (`readDeclaration`, `assertAllowedUrl`) |
| Leaf-import scan that can quarantine us | `server/extensions/external.js` (`FORBIDDEN_IMPORTS`) |
| Skills an extension ships | `server/skill-catalog.js` (`extId` on a catalog entry) |
| Client slots + per-extension client api | `public/slots.js` (`apiFor`, `subscribe`), `public/extensions.js`, `public/app.js` |
| Design spec | `docs/superpowers/specs/2026-09-11-extensions-api-design.md` |
| Where the jobs system came from | agent-wrangler branch `job-system` — `server/job-*.js`, `server/jobs-schema.js`, `server/control/handlers/jobs.js`, `server/mcp/tools/job-report.js`, `public/jobs*.js`, `public/job-graph.js`, `public/diff-return.js`, `agent-skills/skills/job-worker/`, and the diff of `server/index.js`, `server/session-manager.js`, `server/agents/*.js`, `server/mcp/server.js`, `server/worktree.js`, `server/tmux-scraper.js` against `main` |

A detached worktree of `main` sits at
`~/IdeaProjects/agent-wrangler-worktree-ext-api` (cut while scaffolding this
repo, now just a read-only checkout of main); `git -C ~/IdeaProjects/agent-wrangler fetch`
and re-add it if it is gone. `scripts/validate-manifest.mjs` and
`server/integration.test.js` both read it through `AW_REPO`.

## File map

Status: **verbatim** = copied, imports rewired only · **rewritten** = same
shape, new body · **new** · **vendored/copies** = leaf duplicated because the
façade exposes nothing equivalent.

| this repo | from (`job-system` branch) | status | notes |
|---|---|---|---|
| `index.js` | — | new | re-exports `server/manifest.js`; see AGENTS.md for why nothing imports it |
| `server/manifest.js` | `server/index.js` wiring + `agent-skills.js` `AUTOMATION_ONLY` + `mcp/server.js` spawning filter | new | stores, tools, handlers, `skills`/`skillsFor`, `hideTool`, `graph`, `onBeforeDispatch`, 4s sweep, client, styles. Declares no manifest `settings` (see below) |
| `server/jobs.js` | `server/index.js` (JobRunner construction, `statusOf`) | new | `runnerFor(host)` and `spendFor(host)` singletons; graph status cache; `runForSession` replaces `entry.automationRun` |
| `server/job-spend-refresh.js` | `server/index.js` (`refreshJobSpendIfStale`) | rewritten | the 60s per-card price refresh over `host.usage.byCard()`; `byCard(jobs)` serves the last map and kicks the next read, never awaited on the graph tick |
| `server/tools.js` | `server/mcp/tools/job-report.js` | rewritten | two tools (`job_report`, `get_job_context`) in the extension signature `({host, caller}, args)`; `syncBranch` reads a `name_branch` rename back off the projection; `hideTool` |
| `server/handlers.js` | `server/control/handlers/jobs.js` | rewritten | `(msg, host)`; no `ctx.reply` → `host.broadcast`; adds `job-open-session` and `job-open-ide` (macOS `open -na <ideApp>` on a sub-job's worktree, result broadcast as `job-ide-opened` / `job-ide-failed`); `job-settings` keeps job settings in this extension's own store |
| `server/job-runtime.js` | `server/job-runtime.js` | **rewritten** | the only session-facing module: spawns through the façade with 1.4's `worktree`/`addDirs`/`taskId`/PR-automation options, bills a triage with 1.6's `sessions:bill`. Most open gaps are marked here |
| `server/git.js` | `server/worktree.js` (subset) | new | down to `gitRepoRoot` + `removeWorktree --force`: the wrangler cuts and renames worktrees now, cleanup's compare-and-delete is still ours |
| `server/job-store.js` | same | verbatim | `./data-dir.js`, `./atomic-json.js` are local copies |
| `server/job-runner.js` | same | verbatim | `./log.js` is a local leaf |
| `server/jobs-schema.js`, `job-moves.js`, `job-comments.js`, `job-deploys.js`, `job-github.js` | same | verbatim | |
| `server/job-spend.js` | same | verbatim minus the scan walk | `usdByCard` reads the façade's `[{ cardId, usd, estimatedUsd }]` rows instead of `scanAllDaily`'s per-transcript day bags; `withJobSpend`/`withRunStatus` untouched |
| `server/job-prompts.js` | same | verbatim minus `adapterFor` | `modelLabel` prints the raw model value (gap 10); prompts name core's `name_branch` |
| `server/headless-claude.js` | same | verbatim | the comment-triage one-shot; `cleanClaudeEnv` from local `clean-claude-env.js` |
| `server/data-dir.js`, `atomic-json.js`, `log.js`, `clean-claude-env.js` | `server/data-dir.js`, `atomic-json.js`, `log.js`, `agents/claude.js` | copies | leaves the store and triage need before a façade exists |
| `public/index.js` | `public/app.js` (jobs bits), `public/index.html` | new | the `view` contribution; mounts `#jobs` + `<dialog id=job-dialog>` on `<body>`; subscribes to its own `ext:jobs` frames via `api.onMessage` |
| `public/jobs.js`, `jobs-view.js`, `job-graph.js` | same | verbatim | import `./util.js` / `./icons.js` (vendored) |
| `public/diff-return.js` | same | verbatim, **unused** | the diff round trip needs client navigation (gap 12) |
| `public/jobs.css` | `public/styles.css` diff | extracted | `#jobs.hidden` and `.jobs-nav-badge` rules are dead here (no rail badge element); adds this extension's own toast |
| `public/util.js`, `public/icons.js` | `public/util.js` (esc, tildify), `public/icons.js` (ROBOT_ICON, PULL_REQUEST_ICON) | vendored | |
| `skills/job-worker/` | `agent-skills/skills/job-worker/` | verbatim | **live** since agent-wrangler #170: the loader publishes `<dir>/skills/*`, `skillsFor` gates it per launch |
| `server/test-helpers.js` | — | new | the one fake `host` every server suite builds on; deliberately not a `*.test.js` name |
| `server/jobs.test.js`, `public/jobs-view.test.js` | same | ported | see Tests |
| `server/job-runtime.test.js`, `job-prompts.test.js`, `integration.test.js` | `server/job-runtime.test.js`, `jobs-integration.test.js` | ported, re-split | see Tests |
| `server/manifest.test.js`, `public/index.test.js` | — | new | the manifest's own contributions; the client module under happy-dom |
| `server/*.test.js` (moves, deploys, comments, spend) | same | verbatim | |

Not ported because the extension replaced it rather than needing it:
`agents/*.js` `automation` threading (now `skillsFor`), `entry.automationRun`
stamping (now the store's own run→session record, `jobs.js runForSession`).
Everything else that was core-side by nature is in the Core PRs table and has
landed.

## Host API gaps

Each row: what core did → the interim here → the capability that closes it.
"Blocks" says what does not work until it lands. Proposed capability names follow
v1's `<namespace>:<verb>` shape and would be a two-file change in the wrangler
(`extensions/index.js` `CAPABILITIES` + `host-api/v1.js` builder) plus a minor
bump in `host-api/version.js`.

Numbering is kept from the original table — commit messages and agent-wrangler
issues refer to these numbers — so the closed rows are gone but the survivors
keep their numbers.

| # | gap | core did | interim (this repo) | proposal | blocks |
|---|---|---|---|---|---|
| 3 | **spawn correlation tag** | stamped `automationRun` on the entry and called `onAutomationPrepared(sid, wt)` before the pane started | positional `pendingLaunch`, set before `spawn()` and consumed by `noteDispatch()` (`job-runtime.js`); the hook carries the card id but nothing saying which spawn it is for | `sessions:spawn({ tag })` echoed on the `onBeforeDispatch` payload | nothing today — the runner's `busy` guard means one launch at a time; correctness the moment a second concurrent spawn path exists |
| 5 | **session status / liveness** | `lastGraph.sessions[].status` plus a fresh tmux `list-panes` probe (`SessionManager.isSessionAlive`) | the graph status the contributor cached (`jobs.js noteGraph` → `job-runtime.js isAlive`): up to one tick (~4s) stale, and reads a DORMANT card as idle | `projectSession` carries `status` (and `dormant`/`alive`), or a `sessions:probe` capability | precision of the idle-receipt grace timer; `stop()`'s "still running, keep the slot" guard is weaker than core's |
| 7 | **pane read/keys** | answered Claude's first-launch "do you trust this folder" dialog by reading the pane and pressing Down/Enter (`tmux-scraper.js trustDialogState`) | `acceptTrustDialog()` returns false; a worker parked on the dialog waits for a human, visible as needs-you thanks to #156 | the spec says an extension never reaches a pane, so the realistic ask is a core `autoAcceptTrust` option on `sessions:spawn`, not `pane:read`/`pane:keys` | first launch in a repo Claude has never trusted |
| 10 | **agents/models vocabulary** | client read the connect-time `agents` list; prompts pretty-printed through `adapterFor(agent).models` | hard-coded `AGENTS` in `public/index.js` (it WILL drift); `modelLabel` prints the raw value, so a history line reads `· opus` where core read `· Opus 5` | `agents:read` → `host.agents.list()`, and carry it on the graph for the client half | correctness of the New-job form's model dropdown; readable model names in prompts |
| 12 | **client navigation** | `setView('grid')`, `selectSession(sid)`, `openDiffPanel(sid)`, `send({type:'resume'})`, `onDiffPanelClosed` round trip | `job-open-session` wakes a dormant card server-side and the human picks it on the board; `public/diff-return.js` is dead code | `api.openSession(sid)` and `api.openDiff(sid, {onClose})` beside today's `send` / `selectedSessionId` / `requestPanelRender` / `version` / `storage` / `onMessage` | "Open session", "Review code in Wrangler", the diff round trip |
| 15 | **archive review skip** | `archive()` skipped the paid memory review for an `automationRun` session | none — every retired step may trigger a Haiku review when `archiveReviewEnabled` is on | `sessions:archive(sid, { review: false })` | wasted spend per retired step when that flag is on |

Gap 15's marker sits above `stop()` in `job-runtime.js` and covers both
`host.sessions.archive()` calls there (`stop()` and `cleanup()`): the interim is
simply the absence of an option on them.

### Closed

| # | gap | closed by | note |
|---|---|---|---|
| 1 | spawn worktree options | agent-wrangler #169 (host API 1.4), adopted here in `c38b57d` | `spawn({ worktree: { branch, base, auto } })` cuts it, stamps `entry.worktree` and returns the record; the hook carries it too. spawn has no `adopt`, but `createWorktree` adopts a `{ folderName, branch }` pair that is already this repo's worktree on that branch, so a later phase into an EXISTING `sub.worktree` spawns with `cwd: existing.repoRoot` and `worktree: { branch, folderName: existing.path, auto: false }`, the card is stamped, `name_branch` works on the publish run, and `noteDispatch` discards the adopted record so the store keeps its `cleanupHead` and rename (a drifted record fails the launch instead of launching a worker that cannot push) |
| 2 | spawn `addDirs` | #169 | only the planning run passes `addDirs` (`CHECKOUTS_DIR`, `~/IdeaProjects` unless `AW_CHECKOUTS_DIR` says otherwise); a Codex worker's own worktree git dir is granted by the wrangler (`session-manager.js withCodexWorktreeAddDir`) |
| 4 | pre-launch task/memory bind | #169 | `spawn({ taskId })` binds before the pane starts, which is the only ordering Codex honours. `tasks:write` left `requires`: the assign is spawn's own, not an escalation |
| 6 | suspend | — | none was ever needed: `sessions:archive(sid, {cascade:false})` is archiveCascade, so it kills the pane and archives in one call |
| 8 | bill a headless run to a card | host API 1.6 `sessions:bill` | `attributeSpend(sub, liveId)` calls `host.sessions.bill(sub.sessions.at(-1), liveId)`, the façade's bind over `recordPriorLiveSessionId`, so a comment triage's `claude -p` lands on the sub-job's latest card's `priorLiveSessionIds` and the usage scan bills it |
| 9 | usage read | host API 1.6 `usage:read` | `host.usage.byCard()` resolves to one `{ cardId, usd, estimatedUsd }` row per card through the wrangler's own usage memo (#163). `server/job-spend-refresh.js` reads it on core's 60s cadence — only once some run has bound a card, never awaited by the graph contributor, a failed read keeping the previous map — and `withJobSpend` prices jobs and sub-jobs off the map the last refresh produced |
| 11 | client broadcast delivery | #167 (host API 1.2) | `api.onMessage` delivers this extension's `ext:jobs` frames, so the New-job dialog closes on the reply and toasts instead of waiting a graph tick |
| 13 | extension skills | #170 | the loader publishes an installed extension's `skills/*` through `skill-catalog.js`; `skills: ['job-worker']` + `skillsFor` were already correct and simply started working |
| 14 | PR automation off a job PR | #169 | `autoMergeOnPass: false` / `autoFixPrChecks: false` on spawn, so core's nudge and auto-merge are not a second driver on the runner's branch |

### Also worth knowing

- **Manifest `settings` (#166).** The Extensions tab can draw setting rows from a
  manifest's `settings` array and hand the values back (including to the store
  factory). This extension does not use it: job settings still live in its own
  store behind the `job-settings` control handler, which is a candidate to move
  once the surface's types cover what the Jobs view's settings pane needs.
- **Store factory bag (#168, host API 1.3).** The factory is called with
  `{ id, extId, settings, log }`; `server/manifest.js` takes none of them —
  `JobStore` picks its own path via `server/data-dir.js`. Fine as-is, but the
  extras are there if the store path ever becomes configurable.
- `inputSchema` uses **this repo's** `zod` while the wrangler's
  `McpServer.registerTool` wraps it with **its** `zod`; verified working over a
  real `/mcp` call (see Tests).

## Core PRs carved out of `job-system`

Independent of the extension: core fixes the job system relied on that belonged
on `main` as their own small PRs. All are resolved.

| # | change | PR | status |
|---|---|---|---|
| 1 | `tmux-scraper.js` — report Claude's first-launch trust dialog as **needs-you** rather than idle, so the idle-timer suspend cannot reap a worker parked on it | #156 | merged |
| 2 | `session-manager.js refreshAlive` — build the alive/dead sets in locals and swap at the end; publishing empty sets mid-scan made a concurrent liveness reader see every pane as dead | #157 | merged |
| 3 | `worktree.js` — `isValidBranchName`, `createWorktree({ baseRef })`, `flatBranch` in `worktreeDirName`/`repoRootForWorktree`, `renameBranch({ verbatim })` | #158 | merged |
| 4 | `worktree.js` — `removeWorktree` always `--force` (and the `worktree-remove-blocked` reply + client dialog removed with it) | #160 | merged |
| 5 | `session-manager.js resumeEntry` — carry `addDirs` across a resume | #162 | merged |
| 6 | `headless-claude.js` extracted from `archive-review-runner.js` — prerequisite for gap 8's consumer, and de-duplicates the reviewer | #159 | merged |
| 7 | `usage-scan-memo.js` + `cardId` on `scanAllDaily` rows — prerequisite for gap 9 | #163 | merged (2026-09-21) |
| 8 | `pricing.js` gpt-6-astra row; `codex.js` model labels | #161 | closed — not part of this work |

## Tests

`npm test` runs `node --test` over `server/*.test.js` and `public/*.test.js`:
**212 tests, 211 pass, 1 skipped** (the `AW_REPO` guard); with `AW_REPO` set to
a checkout serving host API 1.6, 212 pass. Per file: jobs 76, jobs-view 49,
deploys 16, job-runtime 13, moves 10, prompts 10, manifest 9, spend 7, index 7,
comments 6, spend-refresh 4, integration 3, handlers 2.

`server/test-helpers.js` holds the single fake `host`
(`{ sessions: { spawn, get, archive, wake, bill }, usage: { byCard }, stores.jobs, rebuild, broadcast, log }`,
whose `spawn` fires `onBeforeDispatch` the way the wrangler's dispatch does,
whose `bill` keeps `recordPriorLiveSessionId`'s contract, and whose `byCard`
resolves to whatever rows a test pushed onto the returned `usage` array); it
is deliberately not a `*.test.js` name, and everything it writes goes under the
redirected `DATA_DIR`. `server/manifest.test.js` is the pattern to copy for
signatures, the `onBeforeDispatch` binding, the gates and the graph contributor;
`public/index.test.js` mounts the client module under happy-dom.

`legacy-tests/` is gone: agent-wrangler #168 made the import scanner skip test
files, so the `.mjs` dodge was obsolete and both remaining suites are ported.

- `server/job-runtime.test.js` — the teardown half of core's runtime suite over
  the fake host: `stop()`'s archive-then-confirm, the `isAlive` truth table over
  `archived` + the cached graph status, `noteDispatch` with nothing pending, and
  the compare-and-delete git rules driven through the constructor's injected
  `run`. The launch options live in `manifest.test.js` because the hook is the
  only place they are observable. Dropped as core-only: the
  `SessionManager.refreshAlive` races, the tmux `list-panes` probe and its error
  taxonomy, `automationRun`/`SESSIONS_DIR`/`resumeEntry` stamping, the Codex
  git-metadata `addDirs` (wrangler-side since 1.4), the `acceptTrustDialog` cases
  (gap 7) and the memory-bind assertions. The `recordPriorLiveSessionId` one is
  back as `attributeSpend` over the fake host's `sessions.bill`.
- `server/job-spend-refresh.test.js` — the 60s price refresh with an injected
  clock: first tick empty, a read only once a run has bound a card, one read per
  window and one in flight, a failed read keeping the previous map and backing
  off. `manifest.test.js` drives the same through the graph contributor.
- `server/job-prompts.test.js` — the prompt half (`jobPrompt`, `historyLines`),
  unchanged apart from the model label printing raw (`· opus`) — gap 10.
- `server/integration.test.js` — replaces `jobs-integration.test.js`: the
  manifest's own entries driven in board order (`job-create` → sweep → planning
  launch bound by `onBeforeDispatch` → caller-gated `job_report` →
  `approve-plan` → implementation launch with the wrangler-cut worktree plus
  `cleanupHead` → `hideTool`/`skillsFor` → graph contributor feeding `statusOf`
  → store reopen), plus one test importing `validateManifest` from
  `${AW_REPO}/server/extensions/index.js` that skips when `AW_REPO` is unset.
- `server/jobs.test.js` and `public/jobs-view.test.js` were ported first
  (`a126677`): the view suite verbatim, the store/runner suite verbatim bar its
  MCP/control region, rewired onto `./tools.js` + `./handlers.js`.

Verified against a real wrangler (isolated `AW_DATA_DIR`, extension copied in —
`scripts/dev-smoke.mjs <port>`): boots with no quarantine, announces
`/ext/jobs/index.js` + `/ext/jobs/jobs.css` with the four handler types,
`graph.jobs` present, `job-create`/`job-action` round-trip over the control WS,
the tools listed over `/mcp`, and an invalid `job_report` rejected by input
validation — so this repo's `zod` schemas DO work inside the wrangler's
`McpServer`. Still unverified: the view rendered in a real browser (only under
happy-dom), and a real planning launch (it bills a session).

## Running it for real

1. Run any agent-wrangler `main` checkout with an isolated data dir (the
   wrangler's `run-dev` skill), e.g. `AW_DATA_DIR=~/.agent-wrangler-dev`.
2. Either install from this repo's git URL via the Extensions tab (needs it
   pushed somewhere reachable over https/ssh), or COPY the checkout (with its
   `node_modules`) to `~/.agent-wrangler-dev/extensions/jobs` and restart —
   `rsync -a --exclude .git ~/IdeaProjects/wrangler-squared/ ~/.agent-wrangler-dev/extensions/jobs/`.
   **A symlink is never discovered**: `discoverExternal` keeps
   `dirent.isDirectory()` entries only, and a symlink is not one (verified with
   `scripts/validate-manifest.mjs`). Worth a one-line core fix (`fs.statSync`
   through the link) if hand-dropping stays the dev workflow.
3. Watch the log for `extension jobs quarantined` — the reason names what to fix.
4. Existing jobs: the store path is `<DATA_DIR>/jobs.json`, the same file the
   in-core system wrote, so a live install's jobs carry over.

## Work list, in order

1. Keep the real loader green:
   `AW_REPO=~/IdeaProjects/agent-wrangler-worktree-ext-api node scripts/validate-manifest.mjs`
   runs discovery + import scan, `validateManifest`, `loadExtensions` and
   `buildHostApi` against the wrangler's own code. Then the scanner by hand:
   `grep -rn "from '\.\./index\.js'\|/host-api/\|session-manager\.js\|state-reader\.js\|tmux-scraper\.js" --include=*.js . | grep -v node_modules`
   must be empty.
2. **Boot a dev wrangler on `main` with the extension installed and run a real
   planning job** — still never done. `scripts/dev-smoke.mjs` covers the wire;
   this is the first billed check, the first real exercise of `pendingLaunch` ↔
   `onBeforeDispatch`, and the first time the wrangler cuts a job's worktree for
   real. Open the Jobs view in a browser while it runs, for the CSS.
3. Propose the remaining host-API additions in blocking order: **12** (client
   navigation), **10** (agents vocabulary), **5** (session status), then **15**
   (archive review skip), **3** (spawn tag), **7** (`autoAcceptTrust`). Each is one capability + one builder +
   a minor bump + a row in the spec's table; the extension side is deleting a
   `TODO(host-api …)`.
4. Consider moving job settings from the `job-settings` handler and this
   extension's own store onto the manifest `settings` surface (#166), so the
   Extensions tab owns them like every other extension's.
