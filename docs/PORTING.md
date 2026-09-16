# Porting the job system onto the extensions API

This repo is the automated-jobs system from agent-wrangler's `job-system` branch
(18 commits ahead of `main`, never merged), re-homed as an **installable
extension**. This document is the map for whoever finishes the port: what came
from where, what was rewritten, what is stubbed and why, and what has to change
in agent-wrangler itself.

`grep -rn 'TODO(host-api' server public` is the live list of gaps; every entry
below has one of those at the call site.

## Where the API is

| thing | where |
|---|---|
| Extensions API + HostApi façade | agent-wrangler branch `claude/stack-127-pr-consolidation-2417e5` (PR #139, base `main`; PR #140 already merged into it) |
| Installing from a git URL, quarantine, consent | branch `claude/third-party-extensions` (PR #145, base = #139's branch) — the superset; read this one |
| Design spec | `docs/superpowers/specs/2026-09-11-extensions-api-design.md` on that branch |
| Loader / manifest validation | `server/extensions/index.js` (`validateManifest`, `loadExtensions`, `CAPABILITIES`, `SESSION_HOOKS`) |
| The façade an extension is handed | `server/host-api/v1.js` (`V1_BUILDERS`), `server/host-api/project.js` (what a session/task looks like to us) |
| Install flow, `wranglerExtension` block, lockfile rule | `server/extensions/install.js` (`readDeclaration`, `assertAllowedUrl`) |
| Leaf-import scan that can quarantine us | `server/extensions/external.js` (`FORBIDDEN_IMPORTS`) |
| Client slots + per-extension client api | `public/slots.js`, `public/extensions.js`, `public/app.js` (`extApi`, `renderExtViews`) |
| Where the jobs system came from | agent-wrangler branch `job-system` — `server/job-*.js`, `server/jobs-schema.js`, `server/control/handlers/jobs.js`, `server/mcp/tools/job-report.js`, `public/jobs*.js`, `public/job-graph.js`, `public/diff-return.js`, `agent-skills/skills/job-worker/`, and the diff of `server/index.js`, `server/session-manager.js`, `server/agents/*.js`, `server/mcp/server.js`, `server/worktree.js`, `server/tmux-scraper.js` against `main` |

A detached worktree of the API branch may exist at
`~/IdeaProjects/agent-wrangler-worktree-ext-api` (created while scaffolding this
repo); `git -C ~/IdeaProjects/agent-wrangler fetch` and re-add it if not.

## File map

Status: **verbatim** = copied, imports rewired only · **rewritten** = same
shape, new body · **new** · **stub** = compiles, does nothing, marked.

| this repo | from (`job-system` branch) | status | notes |
|---|---|---|---|
| `index.js` | — | new | re-exports `server/manifest.js`; see AGENTS.md for why nothing imports it |
| `server/manifest.js` | `server/index.js` wiring + `agent-skills.js` `AUTOMATION_ONLY` + `mcp/server.js` spawning filter | new | the manifest: stores, tools, handlers, `skillsFor`, `hideTool`, `graph`, `onBeforeDispatch`, 4s sweep, client, styles |
| `server/jobs.js` | `server/index.js` (JobRunner construction, `statusOf`) | new | `runnerFor(host)` singleton; graph status cache; `runForSession` replaces `entry.automationRun` |
| `server/tools.js` | `server/mcp/tools/job-report.js` (+ `name-branch.js`'s job branch) | rewritten | extension signature `({host, caller}, args)`; adds `job_name_branch`; `hideTool` |
| `server/handlers.js` | `server/control/handlers/jobs.js` | rewritten | `(msg, host)`; no `ctx.reply` → broadcast; adds `job-open-session` |
| `server/job-runtime.js` | `server/job-runtime.js` | **rewritten** | the only session-facing module; every gap is a `TODO(host-api …)` here |
| `server/git.js` | `server/worktree.js` (subset) | new | worktree create/remove/rename + repo root + metadata dirs; exists only because spawn lacks worktree options |
| `server/job-store.js` | same | verbatim | `./data-dir.js`, `./atomic-json.js` are local copies |
| `server/job-runner.js` | same | verbatim | `./log.js` is a local leaf |
| `server/jobs-schema.js`, `job-moves.js`, `job-comments.js`, `job-deploys.js`, `job-github.js`, `job-spend.js` | same | verbatim | |
| `server/job-prompts.js` | same | verbatim minus `adapterFor` | `modelLabel` shows the raw model value; `name_branch` → `job_name_branch` |
| `server/headless-claude.js` | same | verbatim | `cleanClaudeEnv` from local `clean-claude-env.js` |
| `server/data-dir.js`, `atomic-json.js`, `log.js`, `clean-claude-env.js` | `server/data-dir.js`, `atomic-json.js`, `log.js`, `agents/claude.js` | copies | leaves the store and triage need before a façade exists |
| `public/index.js` | `public/app.js` (jobs bits), `public/index.html` | new | the `view` contribution; mounts `#jobs` + `<dialog id=job-dialog>` |
| `public/jobs.js`, `jobs-view.js`, `job-graph.js` | same | verbatim | import `./util.js` / `./icons.js` (vendored) |
| `public/diff-return.js` | same | verbatim, **unused** | the diff round trip needs client navigation (gap below) |
| `public/jobs.css` | `public/styles.css` diff | extracted | `#jobs.hidden` and `.jobs-nav-badge` rules are dead here |
| `public/util.js`, `public/icons.js` | `public/util.js` (esc, tildify), `public/icons.js` (ROBOT_ICON, PULL_REQUEST_ICON) | vendored | |
| `skills/job-worker/` | `agent-skills/skills/job-worker/` | verbatim | **inert** until the API can load an extension's skills (gap below) |
| `server/*.test.js` (moves, deploys, comments, spend) | same | verbatim | pass |
| `legacy-tests/*.test.mjs` | `server/jobs.test.js`, `job-runtime.test.js`, `jobs-integration.test.js`, `public/jobs-view.test.js` | copied, **not run** | import wrangler core (`session-manager`, `mcp/server`, `control/router`, `client-config`); see Tests |

Not ported (core-side by nature — see "Core PRs" below): `tmux-scraper.js`
`trustDialogState` + the `classify()` needs-you rule, `session-manager.js`
`isSessionAlive` / `recordPriorLiveSessionId` / `refreshAlive` snapshot swap /
`worktreeAdopt` / `automationRun` stamping / `addDirs` on resume,
`worktree.js` `baseRef` / `isValidBranchName` / `flatBranch` / `removeWorktree
--force`, `usage-scan-memo.js` + `cardId` on scan rows, `pricing.js` gpt-6-astra,
`agents/*.js` `automation` threading (replaced by `skillsFor`).

## Host API gaps

Each row: what core did → the interim here → the capability that closes it.
"Blocks" says what does not work until it lands. Proposed capability names follow
v1's `<namespace>:<verb>` shape and would be a two-file change in the wrangler
(`extensions/index.js` `CAPABILITIES` + `host-api/v1.js` builder).

| # | gap | core did | interim (this repo) | proposal | blocks |
|---|---|---|---|---|---|
| 1 | **spawn worktree options** | `dispatch({worktree, worktreeAuto, worktreeBase, worktreeBranch, worktreeAdopt})` cut the worktree and stamped `entry.worktree` | `server/git.js` cuts it; session launched into it as a plain cwd | `sessions:spawn` accepts `{ worktree: { base, branch } \| { adopt: record } }` and returns the record | worktree guardrail prompt, card worktree badge/cleanup offer, core `name_branch` on job sessions |
| 2 | **spawn `addDirs`** | Codex workers got the linked worktree's git metadata dirs; planning got `~/IdeaProjects` | none | `sessions:spawn` accepts `addDirs` | Codex PR sub-jobs (cannot fetch/commit in sandbox) |
| 3 | **spawn correlation tag** | `automationRun` stamped on the entry + `onAutomationPrepared(sid, wt)` before the pane started | positional `pendingLaunch` consumed by `onBeforeDispatch` (`job-runtime.js`) | `sessions:spawn({ tag })` echoed on the `onBeforeDispatch` payload | nothing today (one launch at a time); correctness under any second spawn path |
| 4 | **pre-launch memory bind** | `bindMemory: (sid) => memoryStore.bindSession(sid, taskId)` | `host.tasks.assign(sid, taskId)` AFTER spawn — Claude follows the repoint, Codex does not | `sessions:spawn({ taskId })` binding before launch | Codex job sessions' task memory |
| 5 | **session status / liveness** | `lastGraph.sessions[].status` + a fresh tmux `list-panes` probe (`isSessionAlive`) | graph status cached by the contributor (`server/jobs.js noteGraph`), ≤4s stale, reads dormant as idle | `projectSession` carries `status` (and `dormant`/`alive`), or `sessions:probe` | the idle-receipt grace timer's precision; the "still running, keep the slot" guard is weaker |
| 6 | **suspend** | `suspend(sid)` then archive | `sessions:archive(sid, {cascade:false})` — archiveCascade kills the pane too, so one call | none needed unless a job step should stay resumable un-archived | — |
| 7 | **pane read/keys** | auto-accepted Claude's trust dialog (`acceptTrustDialog`) | stub; a parked worker waits for a human | `pane:read` / `pane:keys`, or a core `autoAcceptTrust` dispatch option | first launch in a repo Claude has never trusted |
| 8 | **bill a headless run to a card** | `recordPriorLiveSessionId(sid, liveId)` after comment triage | stub (`attributeSpend`) | `sessions:bill(sid, liveSessionId)` | triage spend in Usage and per-job price |
| 9 | **usage scan** | `cachedScan(scanAllDaily)` → `usdByCard` every 60s | spend map is empty → no prices shown | `usage:read` → `host.usage.byCard()` (cached, never on the rebuild path) | job / sub-job price on the board |
| 10 | **agents/models vocabulary** | client read the connect-time `agents` list; prompts used `adapterFor(agent).models` | hard-coded `AGENTS` in `public/index.js` (drifts!); raw model id in history lines | `agents:read` → `host.agents.list()`, and carry it on the graph for the client | New-job form's model dropdown correctness |
| 11 | **client broadcast delivery** | `ctx.reply({type:'job-created'})` closed the dialog and toasted | server broadcasts `ext:jobs` but `app.js` routes it nowhere; client infers from the next graph | client api `api.onMessage(fn)` for `ext:<id>` frames | toasts; a 4s lag closing the create form |
| 12 | **client navigation** | `setView('grid')`, `selectSession(sid)`, `openDiffPanel(sid)`, `send({type:'resume'})`, `onDiffPanelClosed` round trip | `job-open-session` handler wakes a dormant card; human picks it on the board; `diff-return.js` unused | client api `api.openSession(sid)`, `api.openDiff(sid, {onClose})`; or `sessions:wake` + a `select` broadcast the board honours | "Open session", "Review code in Wrangler", the diff round trip |
| 13 | **extension skills** | `agent-skills/skills/job-worker/` + `automation` flag in both adapters | `skills: ['job-worker']` names a dir the wrangler does not have; `skillsFor` is wired and correct | loader reads `<dir>/skills/*` for an installed extension and merges into `skillEntries` | the job-worker nudge/catalog entry — workers get NO step protocol until this lands (do NOT paste it into `job-prompts.js`; that failure mode is documented in agent-wrangler's CLAUDE.md) |
| 14 | **PR sweep exclusion + auto-fix/auto-merge off** | job sessions filtered out of the legacy PR poll; `autoFixPrChecks:false, autoMergeOnPass:false` stamped | none — a job session that opens a PR may get the core nudge/auto-merge on top of the runner's | `sessions:spawn({ prWatch: false })` | double-driving a job PR if core's auto-merge is on |
| 15 | **archive review skip** | `archive()` skipped the paid memory review for `automationRun` | none — each retired step may trigger a Haiku review if `archiveReviewEnabled` | `sessions:archive(sid, { review: false })` | wasted spend per step when that flag is on |

`inputSchema` uses **this repo's** `zod` while the wrangler's
`McpServer.registerTool` wraps it with **its** `zod`; verified working over a real
`/mcp` call (see Tests).

## Core PRs to carve out of `job-system`

Independent of the extension, these are core fixes that the job system relied
on and that belong on `main` as their own small PRs:

1. `tmux-scraper.js` — `trustDialogState()` and the `classify()` rule that
   reports Claude's trust dialog as **needs-you** (it read as idle, so the
   idle-timer suspend could reap a worker parked on it).
2. `session-manager.js` `refreshAlive` — build the new alive/dead sets in locals
   and swap at the end; publishing empty sets mid-scan made a concurrent
   liveness reader see every pane as dead.
3. `worktree.js` — `isValidBranchName`, `createWorktree({ baseRef })`,
   `flatBranch` in `worktreeDirName`/`repoRootForWorktree`, `renameBranch({ verbatim })`,
   `removeWorktree` always `--force` (and the `worktree-remove-blocked` reply +
   client dialog removed with it).
4. `session-manager.js` `resumeEntry` — carry `addDirs` across a resume.
5. `usage-scan-memo.js` + `cardId` on `scanAllDaily` rows (prerequisite for gap 9).
6. `headless-claude.js` extracted from `archive-review-runner.js` (prerequisite
   for gap 8's consumer, and de-duplicates the reviewer).
7. `pricing.js` gpt-6-astra row; `codex.js` model labels.

## Tests

`npm test` runs `server/*.test.js` and `public/*.test.js` (46 tests, all green
at hand-off). The four pure suites (moves, deploys, comments, spend) pass
unchanged; `server/manifest.test.js` is the fake-host pattern to copy (handler
and tool signatures, the `onBeforeDispatch` binding, gates, graph contributor),
and `public/index.test.js` mounts the client module under happy-dom the way
`public/slots.js` does.

Verified against a real wrangler (API worktree, isolated `AW_DATA_DIR`, extension
copied in — `scripts/dev-smoke.mjs <port>`): boots with no quarantine, announces
`/ext/jobs/index.js` + `/ext/jobs/jobs.css` with the four handler types,
`graph.jobs` present, `job-create`/`job-action` round-trip over the control WS,
`job_report`/`get_job_context`/`job_name_branch` listed over `/mcp`, and an
invalid `job_report` rejected by input validation — so this repo's `zod`
schemas DO work inside the wrangler's `McpServer` (the cross-copy question
above is answered: fine). Not yet verified: the view rendered in a real
browser (only under happy-dom), and a real planning launch (would bill a
session).

`legacy-tests/` holds the suites that import wrangler core and cannot run here
as-is (kept as `.mjs` so the wrangler's own-file import scan never sees them —
see the README there). Porting them:

- `jobs.test.js` — mostly store/runner/prompt tests that only need import paths
  changed (`./mcp/tools/job-report.js` → `./tools.js`, tool handlers now take
  `{ host, caller }` with `host.stores.jobs`/`host.rebuild`). Drop the
  `allowedToolsArg` assertions — the two-place rule is derived for extension tools.
- `job-runtime.test.js` — drove a real `SessionManager`; rewrite against a fake
  `host` (`{ sessions: { spawn, get, archive, wake }, tasks: { assign }, stores, rebuild, log }`).
  The trust-dialog cases go away with gap 7.
- `jobs-integration.test.js` — spun up the wrangler's HTTP/WS/MCP stack; replace
  with a manifest-level test that drives tools/handlers with a fake host, plus one
  test that `validateManifest` (from the API worktree) accepts the manifest.
- `jobs-view.test.js` (happy-dom) — should run once moved to `public/` and its
  `initJobsView` call is given the same `onSession`/`onDiff`/`onBoard` stubs
  `public/index.js` passes; `document.getElementById('jobs')`/`job-dialog` must
  exist in the happy-dom document first.

## Running it for real

1. Run agent-wrangler from the API worktree with an isolated data dir (the
   wrangler's `run-dev` skill), e.g. `AW_DATA_DIR=~/.agent-wrangler-dev`.
2. Either install from this repo's git URL via the Extensions tab (needs it pushed
   somewhere reachable over https/ssh), or COPY the checkout (with its
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

1. `AW_REPO=~/IdeaProjects/agent-wrangler-worktree-ext-api node scripts/validate-manifest.mjs`
   runs discovery, `validateManifest`, `loadExtensions` and `buildHostApi` against
   the real loader; keep it green. Then the scanner by hand: `grep -rn "from '\.\./index\.js'\|/host-api/\|session-manager\.js\|state-reader\.js\|tmux-scraper\.js" --include=*.js . | grep -v node_modules` must be empty.
2. Port `legacy-tests/jobs.test.js` and `jobs-view.test.js` (cheap, high
   coverage); rewrite `job-runtime.test.js` over a fake host.
3. Boot a dev wrangler with the extension copied in (`scripts/dev-smoke.mjs`
   covers the wire; open the Jobs view in a browser for the CSS), start planning
   on a real job and watch a `plan` receipt land via `job_report` — the first
   billed check, and the one that exercises `pendingLaunch` ↔ `onBeforeDispatch`
   for real.
4. Open the core PRs (list above), smallest first.
5. Propose the host-API additions, in blocking order: 13 (skills), 1 (worktree),
   5 (status), 12 (navigation), 10 (agents), 9 (usage), 8 (bill), 2 (addDirs),
   4 (memory), 14, 15, 7, 3, 11. Each is one capability + one builder + a row
   in the spec's table; the extension side is removing a `TODO(host-api …)`.
