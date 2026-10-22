# Porting the job system onto the extensions API

This repo is the job system from agent-wrangler's `job-system` branch
(18 commits ahead of `main`, never merged), re-homed as an **installable
extension**. The port is functionally complete against host API **1.39.0**: every
feature the in-core system had is either wired through the `host` façade or is
one of the open gaps below. This document stays the map — what came from
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
| `server/tools.js` | `server/mcp/tools/job-report.js` | rewritten | three tools in the extension signature `({host, caller}, args)`: `job_report`, `get_job_context` (omits unrelated HUMAN output) and the new `create_job`, the New job form for any agent session (no broadcast, so a human's open form stays open); `syncBranch` reads a `name_branch` rename back off the projection; `hideTool` also hides `create_job` from job steps so a job cannot start jobs |
| `server/handlers.js` | `server/control/handlers/jobs.js` | rewritten | `(msg, host)`; `job-create` is a broadcast wrapper over `job-create.js`; no `ctx.reply` → `host.broadcast`; adds `job-open-ide` (macOS `open -na <ideApp>` on a sub-job's worktree, result broadcast as `job-ide-opened` / `job-ide-failed`); `job-settings` keeps job settings in this extension's own store |
| `server/job-runtime.js` | `server/job-runtime.js` | **rewritten** | the only session-facing module: spawns through the façade with 1.4's `worktree`/`addDirs`/`taskId`/PR-automation options, bills a triage with 1.6's `sessions:bill`, and resumes a session parked on its drafts (`resumeWithMail`: `sessions:wake` when the graph says the card is dormant, then `mail:send`). Most open gaps are marked here |
| `server/git.js` | `server/worktree.js` (subset) | new | down to `gitRepoRoot` + `removeWorktree --force`: the wrangler cuts and renames worktrees now, cleanup's compare-and-delete (and the board's Discard override of a refused one) is still ours |
| `server/job-store.js` | same | modified | `./data-dir.js`, `./atomic-json.js` are local copies; HUMAN completion stores optional multiline `result.output` separately from the 180-character note |
| `server/job-runner.js` | same | modified | `./log.js` is a local leaf; launches a re-planning run, and while a plan change is pending holds every unfrozen sub-job's launches and merges |
| `server/job-replan.js` | — | new | changing a running job's plan: `request-change` on an active job or any of its steps launches a planning run whose receipt is stored as `job.replan.proposal`; `approve-replan` (pinned to the proposal id) merges it, `discard-replan` drops it. Frozen sub-jobs are locked, removed ones are dropped as `superseded`, and a pending change freezes the job: unfrozen sub-jobs launch, merge, take approvals only once it is approved or discarded (running steps carry on). A proposal may also carry a diagnosis, up to three ranked options and pinned actions (`job-actions.js`: forward, rework, accept-red, mark, recover, retry) |
| `server/job-red.js` | — | new | red steps (Design A step 3): with `settings.maxReplans` above 0 the runner sends the planner after a sub-job that went red (`triageRed`: repair limit, post-merge failure, blocked/`replan` receipt, closed PR, refused write, dead session), one replan at a time, holding only that step and the sub-jobs after it (`heldBy`/`redScope`). The sixth checkpoint `reviewRed` decides what happens to its proposal: "You decide" (default) waits for the human (Fix ready), "Wrangler replans" applies a `rework` by itself (plan edits only under Plan: Auto and never cancelling a PR; accept-red, mark, recover and retry never). Out of `maxReplans` tries (Retry grants one more), or on an `escalate` receipt (planner: with up to three options that open as the proposal; step agent: without), or a planner that blocks or dies, the step is DECLARED red (`sub.red.declared`, with every attempt). Board: Fixing is not counted in Needs you, Declared red is. No host-API gap |
| `server/jobs-schema.js` | same | modified | a fourth sub-job kind, `write` (one write to one place: `place:{type, ref?, name?}` with type `jira`/`slack`/`confluence`/`artifact`/`file`/`url`, or `other` (any place an agent can reach, `name`d, whose `write` action is one free-text instruction), `action`, `by:<session>` — every write is made by a session sub-job — `review` (tri-state over the job's `reviewWrites`, read through `writeReviewed`), `why`); a session's `on:{sub, at}` milestone, an edge like `after` (cycles, reachability); `{<write id>.url}` refused unless the same session makes it (no circle) or the linking session waits for the maker to finish; `plan.workflows`, `plan.jiraSite`, `withStoryCreates` (the old job-level `jira` stage folded into a create write per keyless story, owned by a `stories` session it adds or reuses), `completed.writes` (with the older `outputs` still accepted) and the mid-run `drafts` receipt; `jobInputSchema.title` is optional now that the New job form sends only its "Describe job" text |
| `server/job-writes.js` | — | new | writes, each its session's: milestones (`started`/`pr`/`merged`/`deployed`/`dropped`) and `triggerStatus` for a session's `on` (due, waiting, dead on a dropped trigger, not needed once an if-dropped trigger lands), a write dropped with its session or failed when it finishes without reporting it, the `completed` receipt answering for every open write (`applyWrites`; a reviewed made output stops in review after it is published, until Accept), the `drafts` receipt that parks a run until each reviewed write is decided (`applyDrafts`, `draftsDecided`), `{<write id>.url}` templates (a write the same session makes first is named for it to fill in), Retry reopening a failed write by running its session again, and the Write / Edit / Skip actions (Write applies the review panel's edits in the same change; a story create's edit carries the story's title and fields). A write with no `by` predates session-owned writes and is failed on load (gap 19) |
| `server/job-sub-ops.js` (what is left of the seven moves: dropSub, reworkSub, validatePlan, keyStory), `job-change.js` (new: `request-change`), `job-comments.js`, `job-deploys.js`, `job-github.js` | same | verbatim | bar the seven moves, which are gone (Fix here, Split out, New ticket, Reorder, Drop, Mark position and Accept red: `applyMove`, `moveSchemas`, `MOVE_NAMES`, the dialogs, `movesFor`/`moveCopy` and `blocked.move`), leaving the helpers the runner and plan changes share; `validatePlan` looking past a write from before session-owned writes, and the PR's `title` read for `{pr.title}` |
| `server/job-create.js` | `server/control/handlers/jobs.js` (`job-create`) | new | the one create path (`makeCreateJob`) behind `job-create` and `create_job`: input and Task validation, create, optional start, rebuild, runner `kick`, title generation |
| `server/job-title.js` | — | new | names a job from its description: `create` stores a first-line fallback, then `job-create.js` (`makeCreateJob`) asks Haiku through `headless-claude.js` and `retitle`s without a revision bump; the spend is billed to the job's latest run card if one is up by then |
| `server/job-spend.js` | same | verbatim minus the scan walk | `usdByCard` reads the façade's `[{ cardId, usd, estimatedUsd }]` rows instead of `scanAllDaily`'s per-transcript day bags; `withJobSpend`/`withRunStatus` untouched |
| `server/job-prompts.js` | same | modified | `modelLabel` prints the raw model value (gap 10); prompts name core's `name_branch` and pass bounded direct HUMAN dependency output to workers; a session's prompt carries every write it owns with the read-first rules for those places only and the drafts step for reviewed ones, and `draftsDecidedMail` is what a parked session is told once its drafts are decided |
| `server/headless-claude.js` | same | verbatim | the comment-triage and job-title one-shot; `cleanClaudeEnv` from local `clean-claude-env.js` |
| `server/data-dir.js`, `atomic-json.js`, `log.js`, `clean-claude-env.js` | `server/data-dir.js`, `atomic-json.js`, `log.js`, `agents/claude.js` | copies | leaves the store and triage need before a façade exists |
| `public/index.js` | `public/app.js` (jobs bits), `public/index.html` | new | the `view` contribution; mounts `#jobs` (a job opens as a page inside it, gap 25) + `<dialog id=job-dialog>` on `<body>` for an idea not yet a job, New idea, Automation settings and a plate's Cancel; subscribes to its own `ext:jobs` frames via `api.onMessage`; `badge()` gives the rail button the needs-you count (gap 16) |
| `public/jobs.js`, `job-graph.js` | same | modified | import `./util.js` / `./icons.js` (vendored); writes fold into one place pill per place under the session that makes them, a session's `on` is a dotted connector from its trigger and a line on its node, a session parked on drafts says how many wait for you, and the board card carries a strip of every place (writes add no progress segment); a local file shows its path to copy (gap 20) |
| `public/jobs-view.js` | same | modified | `render()` no longer writes `#jobs-nav-badge`: that element was core's `index.html`, and the count is the `view` contribution's `badge()` now (gap 16). The in-view `#jobs-review-count` beside the Needs me filter is unchanged; HUMAN tasks have an optional result form; New job has one "Describe job" box and no Title |
| `public/model-picker.js`, `public/model-plates.js` | — | new | New job's agent/model/effort: a ticket plus inline effort meter in the sidebar and a cabinet over the brief column. `describe()` turns a catalog entry into family/version/plate, the plates draw it (galaxy = one rAF loop, stopped on close/re-render); hidden `agent`/`model`/`effort` inputs keep `form.onsubmit` unchanged, and creating a job saves `settings.usualPick` through `job-settings` (gap 18 for the version) |
| `public/diff-return.js` | same | verbatim but its owner comment | the diff round trip's return decision; `public/index.js` `reviewDiff` calls it from `api.openDiff`'s `onClose` (gap 12) |
| `public/jobs.css` | `public/styles.css` diff | extracted | the `#jobs.hidden` rule is dead here (core hides the view's HOST, not `#jobs`); the `.jobs-nav-badge` / `button[data-view=jobs]` rules went with gap 16, since the span and its positioning are core's now; adds this extension's own toast |
| `public/util.js`, `public/icons.js` | `public/util.js` (esc, tildify), `public/icons.js` (ROBOT_ICON, PULL_REQUEST_ICON) | vendored | plus the place glyphs (ticket, hash, page, file, globe), generic strokes rather than brand logos |
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
| 10 | **agents/models vocabulary (server half)** | prompts pretty-printed through `adapterFor(agent).models` | `modelLabel` (`job-prompts.js`) prints the raw model and effort, so a history line reads `· opus high` where core read `· Opus 5.5`. The client half closed in 1.25 (below) | `agents:read` → `host.agents.list()` | readable model names in prompts |
| 15 | **archive review skip** | `archive()` skipped the paid memory review for an `automationRun` session | none — every retired step may trigger a Haiku review when `archiveReviewEnabled` is on | `sessions:archive(sid, { review: false })` | wasted spend per retired step when that flag is on |
| 18 | **resolved model id on aliases** | the board's own pickers name `opus` by the id the wrangler resolves it to (`Opus 5.5`) | `api.agents()` carries only the alias, so New job's model picker (`public/model-plates.js` `describe`) shows the family alone (`Claude Opus`), derives a version only from a full id (`claude-opus-6`), and Fable's numeral falls back to the family initial; a `TODO(host-api agents-resolved-id)` marks the call site | `api.agents()` models carry the resolved id (e.g. `resolved: 'claude-opus-5-5'`) | version in the ticket, cabinet title and Fable numeral for an alias |
| 19 | **writes to Jira, Slack and Confluence** | nothing like it: core's ticketing step was one agent session that created the approved stories | a `write` sub-job per write, each owned by a session sub-job (`by`) that makes it with the Atlassian and Slack MCPs, reading each place first, and answers for it in its `completed` receipt — `written` / `already` / `failed` with a permalink (`job-writes.js applyWrites`); a write due at a milestone is a small session with `on`; a reviewed write is drafted, the run parked, and the session mailed the decided writes (`mail:send`, `sessions:wake` for a dormant card). The planner reads each project's workflow statuses and the Jira site and returns them with the plan, so the board offers real status names and ticket links without a client. Marker: `TODO(host-api jira:write, slack:write)` in `job-prompts.js` | `jira:write` → `host.jira.{ get, transition, comment, create }`, `slack:write` → `host.slack.{ history, post }` (and Confluence's page/comment calls) over the wrangler's own connections | nothing — the cost is a turn of an agent session per write instead of an HTTP call |
| 20 | open a local file (closed, host API 1.38) | nothing like it | a `file` place (an output a session made) shows its absolute path in the pill's popover and the write's dialog. With `files:view` granted, the server registers each reported file with `host.files.allow` (`server/job-files.js`, on the receipt and each tick) and, when the host's client `api.files.canOpen(path)` says it can show that type (markdown first), Open sits beside Copy and calls `api.openFile(path)`. A host without `api.files`, or a type it cannot show, keeps path + Copy only | host client `api.openFile` / `api.files` and the `files:view` capability | opening a made report in one click |
| 21 | **serve an extension's files** | nothing like it | a Code review step's proof (screenshots, GIFs, WebM clips the agent saved) lives in the extension's own folder (`server/job-evidence.js`, `<DATA_DIR>/evidence/<job>/<sub>/round-<n>/`); no route serves it, so `job-evidence` (`handlers.js`) sends the round's `sips` thumbnails, and one full file when a shot is opened, as base64 over `host.broadcast`, like `job-images`. A clip is capped at 5 MB with every other file. Marker: `TODO(host-api files:serve)` in `handlers.js` and `public/job-proof.js` | `files:serve`: a host route that serves a file under the extension's data dir, so a thumbnail is an `<img src>` and a clip streams | a long review round sending every thumbnail over the websocket |
| 22 | **spawn `env`** | nothing like it | the proof folder is `$JOB_EVIDENCE` only by the prompt's say-so: a Claude or Codex step is told to `export JOB_EVIDENCE=<inbox>` before it works, and the same path is granted as an `addDirs` entry (`job-runtime.js launch`, Claude and Codex but not Codex on Full access, which needs none). Marker: `TODO(host-api spawn env)` in `job-evidence.js` and `job-prompts.js` | `spawn({ env })`: variables set on the session before its pane starts | an agent that ignores the export and saves somewhere else gets its receipt refused (`not in $JOB_EVIDENCE`) rather than silently losing proof |
| 23 | **images on mail** | nothing like it | a picture pasted into the Request changes box of a Code review step is kept by the handler in the round's evidence folder (`job-evidence.js keepAskImages`, `handlers.js prepare`) and the parked session is mailed its absolute path to read (`job-prompts.js threadMail`), because `mail:send` carries text only. Marker: `TODO(host-api mail:images)` | `mail.send(to, text, { images })`, attaching them the way `spawn({ images })` does | the session sees the picture instead of having to open a file |
| 24 | **processes** | nothing like it | a Code review step's agent leaves what the change needs running (`ready.running`, started detached with `setsid`) for the human to try, and the extension tears it down on approve, drop, cancel, replan, cleanup and boot (`server/job-running.js`): `process.kill(-pid)` on the group, each `stop` command through `sh -c` in the worktree under a `sandbox-exec` profile that writes only the worktree, the proof inbox, the job's `writableDirs` and temp (unsandboxed only for a Codex job on Full access; not run at all where no sandbox exists), the URLs fetched until they stop answering, and the Logs button reads the tail of a log file under the worktree or the proof folder. No façade offers any of this, so it uses `child_process`, `fetch` and `fs` directly, in the wrangler's own process and as its user | a `processes:*` capability: signal a process group the extension's session started, run a command in a session's worktree, and a files read scoped to it, all declared in `wranglerExtension` and shown at consent | `TODO(host-api processes)` in `server/job-running.js` |
| 25 | **a view's own route** | the job dialog was core's, opened over whatever view was showing; no route reached it either | a job opens as a page inside the Jobs view (`public/jobs-view.js` `page`: a sticky bar with Back and the trail Jobs › job › step, Esc up from a step), in place of the board. The view host already gives the extension the whole pane, so the page needs nothing new, but the only route is `#view=ext:jobs:board`: a reload, a link or the browser's Back lands on the board, and leaving the view and coming back keeps the page only while the host stays mounted. Marker: `TODO(host-api view-path)` in `public/jobs-view.js` | `#view=ext:jobs:board/<path>`, the path handed to `mount(el, api, { path })` and changed with `api.setViewPath(path)` | a job or step that survives a reload, or can be linked to |

Gap 15's marker sits above `stop()` in `job-runtime.js` and covers both
`host.sessions.archive()` calls there (`stop()` and `cleanup()`): the interim is
simply the absence of an option on them.

### Closed

| # | gap | closed by | note |
|---|---|---|---|
| 1 | spawn worktree options | agent-wrangler #169 (host API 1.4), adopted here in `c38b57d` | `spawn({ worktree: { branch, base, auto } })` cuts it, stamps `entry.worktree` and returns the record; the hook carries it too. spawn has no `adopt`, but `createWorktree` adopts a `{ folderName, branch }` pair that is already this repo's worktree on that branch, so a later phase into an EXISTING `sub.worktree` spawns with `cwd: existing.repoRoot` and `worktree: { branch, folderName: existing.path, auto: false }`, the card is stamped, `name_branch` works on the publish run, and `noteDispatch` discards the adopted record so the store keeps its `cleanupHead` and rename (a drifted record fails the launch instead of launching a worker that cannot push) |
| 2 | spawn `addDirs` | #169 | only the planning run passes `addDirs` (`checkoutsDir()`: `AW_CHECKOUTS_DIR`, else `~/IdeaProjects`, and none at all when that folder does not exist, since a missing `--add-dir` fails the launch; the prompts then tell planning to clone beside the checkouts it found); a Codex worker's own worktree git dir is granted by the wrangler (`session-manager.js withCodexWorktreeAddDir`) |
| 4 | pre-launch task/memory bind | #169 | `spawn({ taskId })` binds before the pane starts, which is the only ordering Codex honours. The spawn-time assignment itself is not a `tasks:write` escalation; this extension now requests `tasks:read`/`tasks:write` separately so New job can validate an existing Task or create one. |
| 6 | suspend | — | none was ever needed: `sessions:archive(sid, {cascade:false})` is archiveCascade, so it kills the pane and archives in one call |
| 8 | bill a headless run to a card | host API 1.6 `sessions:bill` | `attributeSpend(sub, liveId)` calls `host.sessions.bill(sub.sessions.at(-1), liveId)`, the façade's bind over `recordPriorLiveSessionId`, so a comment triage's `claude -p` lands on the sub-job's latest card's `priorLiveSessionIds` and the usage scan bills it |
| 9 | usage read | host API 1.6 `usage:read` | `host.usage.byCard()` resolves to one `{ cardId, usd, estimatedUsd }` row per card through the wrangler's own usage memo (#163). `server/job-spend-refresh.js` reads it on core's 60s cadence — only once some run has bound a card, never awaited by the graph contributor, a failed read keeping the previous map — and `withJobSpend` prices jobs and sub-jobs off the map the last refresh produced |
| 12 | client navigation: open a session | host API 1.8 `api.openSession(sid)` | the client façade does what core's `onSession` did — `setView('grid')`, then `selectSession(sid)` for a card on the board or `send({type:'resume'})` + toast for one that is not — so `onSession` is the one call and the interim `job-open-session` handler (server-side `sessions:wake`, human picks the card) is gone, and `sessions:wake` with it — until session-owned writes brought it back for one job of its own: waking a dormant session parked on drafts (gap 19). `onBoard` reads `graph.sessions` off the view's `update(el, session, graph)`, which is what labels the button Open vs Restore. Host API 1.27 (agent-wrangler #294) also made it land on the card: out of the tray, scrolled into view, and still fulfilled once a restored card comes back |
| 17 | job images (server half) | host API 1.31 `images:keep` + `spawn({ images })` | a job carries `images` (minted names) and `shareImages` (default on). `makeCreateJob` copies each staged name into the extension's own store with `host.images.keep` (a staged name is single-use and pruned after a week) and fails the create if one is gone; `JobRuntime.imagesFor` passes them to every planning spawn and, with sharing on, every sub-job spawn (not a write step), skipping a name the store lost; `releaseImages` removes them when the job finishes. The client half is row 17b |
| 17b | job images (client half) | host API 1.31 client `api.images.stage` | New job's Outcome is a field with a tray (`public/job-images.js`): paste, drop or Attach, up to 8, numbered thumbnails from local object URLs, a spinner until `stage` resolves the minted name, per-file errors naming non-images, click to enlarge, and Start planning / Add to backlog disabled while anything is decoding or uploading. A sharing switch (default on) appears with the first image. `clipboard-images.js` is a vendored copy of the board's, so paste/drop sources are read the same way. The job dialog's Outcome shows a numbered strip: the kept bytes are not served by anything, so the `job-images` control handler broadcasts them as base64 once per job per view |
| 12 | client navigation: the diff panel | host API 1.27 `api.openDiff(sid, {onClose})` | "Review code in Wrangler" opens the card's diff panel over the grid, and `onClose` runs core's `diffReturnTarget` (`public/index.js` `reviewDiff`): back to `#view=ext:jobs:board` with the same detail open. Core disarmed the trip when the reader left the grid or picked another card; `onClose` fires on those closes too, so `reviewDiff` waits a tick and stays put on a `#view=` hash or another selected card. Every run of a sub-job shares its worktree, so the button opens the latest run already on the board and only falls back to the latest (which resumes its agent) when none is |
| 10 | agents/models vocabulary (client half) | host API 1.25 `api.agents()` | the New job form reads the board's live-catalog agent list (models and efforts) each time it opens, replacing the hand-copied `AGENTS` table that had already drifted. It gained an Effort select (Default plus the agent's levels), stored as `job.effort`, passed to `spawn` and recorded on each run beside `model` |
| 11 | client broadcast delivery | #167 (host API 1.2) | `api.onMessage` delivers this extension's `ext:jobs` frames, so the New-job dialog closes on the reply and toasts instead of waiting a graph tick |
| 13 | extension skills | #170 | the loader publishes an installed extension's `skills/*` through `skill-catalog.js`; `skills: ['job-worker']` + `skillsFor` were already correct and simply started working |
| 14 | PR automation off a job PR | #169 | `autoMergeOnPass: false` / `autoFixPrChecks: false` on spawn, so core's nudge and auto-merge are not a second driver on the runner's branch |
| 16 | **rail-button count** | agent-wrangler `view` badge (host API 1.7) | core owned `<span id="jobs-nav-badge">` in `index.html` and jobs-view.js filled it, so the needs-you count showed from any view; the port lost the element with the file. A `view` contribution now carries `badge`, a function core calls where views already tick (`app.js updateExtViews` → `slots.syncHosts`, under the same try/catch-and-drop discipline as mount/update) and renders into a span it owns on the rail button it built — falsy or absent draws nothing. Smuggling a badge into `icon` markup was the alternative and was rejected: the rail is core's chrome, `#nav-rail button` has no `position`, and the next extension would re-invent it. Adopted here as `badge: () => needsMe` in `public/index.js`, counted off `graph.jobs` on every tick. The badge alone would not have moved `engines.wranglerApi` (an older board spreads the unknown key and ignores it, so it only loses the count); the `^1.27.0` pin (`api.openDiff`, gap 12) covers it |

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
**742 tests, 741 pass, 1 skipped** (the `AW_REPO` guard); with `AW_REPO` set to
a checkout serving host API 1.31 or later, all 742 pass. CI
(`.github/workflows/test.yml`, on every PR and push to `main`) checks out
agent-wrangler `main` beside this repo, sets `AW_REPO` to it, and runs
`scripts/validate-manifest.mjs` before `npm test`, so the real-loader test never
skips there.

`server/test-helpers.js` holds the single fake `host`
(`{ sessions: { spawn, get, wake, archive, bill }, mail: { send }, usage: { byCard }, stores.jobs, rebuild, broadcast, log }`,
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
  `run`, plus real-git cases (a bare origin, clone and worktree under the
  redirected `DATA_DIR`) for what a refusal lists and what Discard deletes. The launch options live in `manifest.test.js` because the hook is the
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
3. Propose the remaining host-API additions in blocking order: **10** (agents vocabulary), **5** (session status), then **15**
   (archive review skip), **3** (spawn tag), **7** (`autoAcceptTrust`). Each is one capability + one builder +
   a minor bump + a row in the spec's table; the extension side is deleting a
   `TODO(host-api …)`.
4. Consider moving job settings from the `job-settings` handler and this
   extension's own store onto the manifest `settings` surface (#166), so the
   Extensions tab owns them like every other extension's.
