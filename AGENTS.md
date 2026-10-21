# AGENTS.md

Developer notes for Wrangler² — a new way of working with AI (work broken into
AI sessions and PRs, with proof that changes work) as an installable Agent
Wrangler extension. Only the non-obvious, durable things; point at code rather
than re-deriving it. **Read `docs/PORTING.md` first**: the port is functionally
complete on host API 1.39.0, and that file is the map (what came from where, what
stands in for what, and which of the eight open host-API gaps block which
feature).

## This repository is public open source

> **Everything here is public: code, commits, branch names, PR titles and
> bodies, review comments, docs and test fixtures.** Never put anything specific
> to an employer or its customers in any of them: internal repo or service
> names, hostnames, internal or customer URLs, ticket keys, chat channels,
> colleague names, credentials or tokens, or internal process. Keep examples
> generic (`example.com`, `acme/widgets`, `PROJ-123`). If a change only makes
> sense with such a detail, leave the detail out and say so to the human
> instead.

## This repository's own issues

Some work on this repo is tracked in its GitHub issues. A planner for a
Wrangler² job that targets this repo looks for a matching open issue (`gh issue
list`/`gh issue view`) and proposes writes there with
`place: {type: "other", name: "GitHub", ref: "charlie-ps/wrangler-squared#N"}`: a comment
linking the PR (`{pr.url}`), or closing the issue once the PR merges
(`on: {sub, at: "merged"}`). Work with no issue may propose creating one.
Issues are optional, like Jira stories: never invent a number, and keep issue
text as public as the rest of this repo.

## What this is

- An **external extension** for agent-wrangler's extensions API, which is on
  agent-wrangler `main` (host API 1.39.0). Spec:
  `docs/superpowers/specs/2026-09-11-extensions-api-design.md` in that repo.
- The wrangler clones this repo into `<DATA_DIR>/extensions/jobs/`, runs
  `npm ci --ignore-scripts`, and imports `index.js`. **The manifest `id` (`jobs`)
  MUST equal that directory name** or the asset route, provenance record and
  uninstall path disagree. `package.json`'s `wranglerExtension` block is what the
  human consents to BEFORE any code runs, so it and `server/manifest.js` are
  duplicated by design and must agree (`id`, and `requires` in the manifest may
  not be WIDER than the block's). `requires` is the six `sessions:*` (read, spawn,
  archive, bill, wake, interrupt) plus `mail:send`, `tasks:read`/`tasks:write`, `usage:read`,
  `board:rebuild`/`board:broadcast`, `images:keep` and `files:view`. Task read/write lets New job validate a
  selected Task or create one; spawn's `taskId` still binds task memory and
  assigns the card itself. `mail:send` and `sessions:wake` (both host API 1.0)
  resume a session parked on its drafts once the human has decided them:
  mail carries the final writes, and a card gone dormant meanwhile is woken
  first. `engines.wranglerApi` is
  `^1.39.0`: 1.4 added the worktree/`addDirs`/`taskId`/PR-automation spawn
  options this repo depends on, 1.6 the `usage:read`/`sessions:bill` pair the
  Jobs board's prices and triage billing depend on, 1.8 the client
  `api.openSession(sid)` behind the sub-job dialog's Open/Restore session button
  (the board resumes a card the human opens; `sessions:wake` is only the
  drafts resume above),
  1.7 the `view` `badge()` core draws the needs-you count from, 1.25 the
  client `api.agents()` the New job form reads its models and efforts from,
  1.27 the client `api.openDiff` behind Review code in Wrangler, and 1.31 the
  `images:keep` capability plus the `images` spawn option behind a job's attached
  images (client `api.images.stage` stages them; the job keeps its own copies; the New job tray is `public/job-images.js`, built on a vendored `public/clipboard-images.js`), and 1.38 the `files:view` capability plus client `api.openFile`/`api.files` behind Open on a file place (`server/job-files.js` registers each reported path; `public/job-graph.js filePathHtml` shows Open only when `api.files?.canOpen(path)`), and 1.39 the manifest's `earlyAdopter: {branch: 'next'}` (mirrored in the `wranglerExtension` block, which is what is consented to) plus client `api.earlyAdopter` behind the hidden early-adopter switch (`public/early-adopter.js`: Wrangler²'s own theme swapped back and forth between the same two themes within 10s (off yours, on, off, on) opens a small dialog; the host draws no UI for it and follows the branch only from the next update).
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
- **A job's spend limit is `settings.spendLimit` × (1 + `job.topUps`), never stored**
  (`server/job-budget.js`). The runner's `enforceBudget` runs first each tick: over, it sets
  `job.budgetPaused` (claim and `allowed()` refuse it, as does a main
  resolution) and interrupts each `working` run card through `sessions:interrupt`, one per card
  per `INTERRUPT_COOLDOWN_MS`, stamping `run.budgetHaltedAt`; under again it releases the job and
  mails each halted run to carry on. `settle()` never idle-reaps a budget-paused job's runs. The
  spend is `JobSpendRefresh.current` (the 60s scan with each card's highest live graph `usd`
  folded in), the same figure the board shows. Resume clears only `job.paused`; `top-up` (pinned
  to `topUps`) is the human's way past the limit.
- **Every write is made by the session it names (`by`)**, and that session's
  `completed` receipt must answer for each one it owns (`job-writes.js
  applyWrites`; a missing one refuses the receipt). There is no batched writer:
  a milestone (`on`) is a session's, and a write due at one is a small session.
  A reviewed write is drafted: the `drafts` receipt PARKS the run
  (`run.parkedAt`, no `run.report`), and `settle()` holds a parked run only to
  its card existing — never to status or the idle grace — until every draft is
  decided and the runner mails it (`run.mailedAt`). Don't let a new liveness or
  idle rule reach a parked run. A stored write with no `by` predates this and is
  failed on load (`job-store.js migrateSessionWrites`), never run;
  `validatePlan` looks past it so a plan edit still works on that job.
- **One action brings an idea in: `request-change {subJobId?, at, ref, text}`**
  (`server/job-change.js`), from the Add idea box (`changeBoxHtml`, plain words
  plus pictures, no chips) on every step, review and proposal; it replaced `revise-session`, both `replan` forms, `fix-here`
  and the seven moves (Retry stays a button). `at`/`ref` pin it to what the
  human read (`changeView`, mirrored client-side in `public/jobs.js`): a moved
  head, receipt, revision or proposal refuses it. Every idea goes to ONE
  recipient, the planner (`requestReplan`, with `replan.source = {sub, at, ref}`
  and the idea's `images`), unless it reads as a question (an ask run, below), and
  except a first plan (redrawn via `job.feedback`); a
  declared red still goes up with what was tried. The planner sorts it into
  actions on live steps (`forward` to a session parked on review, `rework`) and
  plan edits, and the human approves that proposal (one of `forward`s alone is
  applied at once, `forwardsOnly`): an action on the source step
  is refused at stamp and approval once its view has moved (`job-actions.js
  sourceHolds`). A second idea while a proposal waits adds to it (`Earlier: … /
  Now: …`, `previousActions`); while the planner is drawing one, another change (or an ask run's hand-over) joins the FIFO
  `job.replanQueue` with its convo, source and images (`requestReplan` returns `{queued}`, its
  conversation says so), and `startQueued` makes the next one its own replan once the current one is
  approved or discarded and no planner is still drafting (the runner retries it each tick).
  The box is not a `<form>`, so
  a tick's redraw is held back only while text is typed in it. Its pictures are
  kept (`handlers.js prepare`: the round's folder, else `ideasDir`) and reach the
  planner as paths in the idea's words; a `forward` to the step it was typed on
  carries that round's pictures as thread images. What was sent stays as a bubble (`askSent`) until the dialog
  moves on, ticked by `job-action-complete`, refused back into the box.
- **The Add idea box writes to conversations with "the wrangler"** (`server/job-talk.js`,
  `public/job-talk.js`). "The wrangler" is the board's name for the planner: every
  user-facing string says it, internal identifiers (`planner`, `job.replan`,
  `route: 'planner'`) do not. On a running job every idea is said on `job.talk`
  (capped at 200) in one of `job.convos` (`m.convo`; `request-change {convo?}`, none
  opens a new one, from the job or from a step, `convo.sub`), which outlive a plan
  change: human messages, answers, errors and one `kind:'proposal'` card per
  proposal (`noteProposal`, drawn in `job.replan.convo`), whose `outcome` (approved,
  discarded, revised) `approveReplan`, `discardReplan` and `requestReplan` stamp.
  Several conversations answer AT ONCE, each with its own ASK run (`run.convo`,
  `run.ask`): `claim` lets one run per conversation stand beside the plan run, and
  `activeFor`, `requestReplan` and `triageRed` look past ask runs. An idea that
  `looksLikeQuestion` sets `convo.pending = {asks, source, images}`; ANYTHING said in
  that conversation before its run replies is one more ask for the SAME run: queued
  before launch it rides in the prompt (`claim` marks it sent), after launch the
  runner mails it (`deliverAsks`, `askMail`), never a new run. An ask run never sets
  `job.replan`, so a question holds nothing. It answers with `reply` (`answerAsk`,
  ends the run; asks it never read start the conversation's next run, which reads
  that conversation's last 12 messages), or proposes with `plan` (`askToReplan`
  folds every ask into `requestReplan` exactly as a change idea, Earlier/Now
  included). Each wrangler's prompt lists the others at work (`otherWranglers`: other
  pending conversations and a plan change being drawn). A fresh replan run may also
  `reply` when the idea was only a question (`answerReplan`, refused once a red or
  earlier proposal rides on it). An ask run that dies or blocks says so in its
  conversation (`askFailed`), never `job.error`. `planningRun` (client) ignores ask
  runs, so Approve change stays live while one answers. Every conversation ends in
  its own box (`boxHtml`, `data-change-convo`), and the box below them all starts a
  new one; pasted pictures and the sent bubble belong to the box they were used in
  (`askImages[].box`, `askSent.convo`). A conversation opened from a step
  (`convo.sub`) is that step's: its wrangler's prompt names the step
  (`stepConvoLine`), and it shows ONLY on that step's dialog until the wrangler
  escalates it (`reply {escalate:true}`, or any proposal it draws, `escalate` →
  `convo.escalatedAt`); then the job's list shows it too (`talkFor`, client-side
  only). A step's dialog shows only what was said on it. A conversation not at work and not the one
  the human spoke in last folds to a strip (`convoOpen`; clicks are client-side, per id), and its ×
  (`dismiss-convo`, refused while it answers or holds a plan change) stamps `convo.dismissedAt`,
  which hides it everywhere until anything new is said in it (`say` clears it, so a reply
  from a stale box or a wrangler's message brings it back). A job
  saved with the old single `job.ask` is migrated on load (`migrateTalk`). Open PR #209
  keeps a step's sent ideas on `job.replan.asks`; once both land, the step dialog
  should draw them from the thread, not twice.
- **A plan change never pauses the job** (`server/job-red.js heldBy`, mirrored as
  `heldByReplan`). While the wrangler drafts, only the step the idea was typed on
  (`job.replan.source.sub`) waits; once its proposal is up, so does every step it
  edits, cancels or acts on in any option (`touchedBy`); a red replan adds its
  `redScope`. Everything else launches, merges and gets approved, so a proposal
  can go stale under it: `mergeReplan` at approval refuses that, as before. A replan
  planner that dies or blocks says so in its conversation and drops the change
  (`job-talk.js replanFailed`); only one with no conversation still sets
  `job.error`. On approval (`approveReplan`) a red step whose brief or `after`
  changed is re-queued (PR #220's hunk, kept byte-identical so the two merge cleanly), and an
  open PR whose only change is `after` CATCHES UP instead of a rework:
  `sub.catchUp` stops repairs and merges until its new prerequisites land, then the
  runner updates its branch once. Each proposal carries `then` (`thenOf`), the
  card's "Re-queued · starts after …" line, drawn in the thread and proposal view.
- **Red steps go up one level before the human** (`server/job-red.js`). A sub-job
  with an `error` is sent to the planner by the runner's `triageRed` when
  `settings.maxReplans` > 0 (0 = the old "red waits for you"), one replan at a
  time, stamped `run.red` and counted per step; the replan carries `job.replan.red
  = {sub, auto, n}` and holds only that step and its dependants (`heldBy`, mirrored
  client-side as `heldByReplan`/`redScope`: use them, never `!job.replan`, for
  per-sub gates), plus whatever its proposal touches. The prompt lists the other red
  steps so one cause gets one proposal. The sixth checkpoint `reviewRed` (true = "You decide", the
  default) only chooses whether the proposal waits; Accept red, Mark, Recover and
  Retry are never applied automatically. A red is DECLARED by `declareRed` (tries used up,
  `escalate`, a planner that blocked or died, an empty proposal) and its
  `declared.ref` is `redRef` (error, head, merge commit, run count): a new
  failure, head or run un-declares it and a decision about the old one
  (`red.held`) never carries over. `blocked`, `replan` and `escalate` are the
  "go up one level" receipts. The board's states are `redFixing` (not counted in
  Needs you), `redFixReady` and `redDeclared` in `public/jobs.js`.
- **A proposal can carry actions and up to three ranked options**
  (`server/job-actions.js`, applied by `approveReplan`): `accept-red`, `retry`, `mark`
  (merged/done, `evidence` required), `rework` and `recover {fix}` on a live
  sub-job. The server stamps each with a pin (PR head, merge commit, stage or, for
  a retry, the failure's `redRef`) at
  proposal time and `approve-replan` refuses if it moved; the planner never
  writes a pin (the schema is strict). Options are the receipt's own plan first,
  then `alternatives` (max 2), each merged and stamped when the receipt lands, so
  one bad option refuses the whole receipt; approve takes `option`. An action is
  drawn as a mark on its graph node (`actionMark`).
- **A session parks after `ready`, so the human can ask it things** (`server/job-parked.js`).
  With Code on You review the `ready` receipt does NOT set `run.report` (that ends a run):
  it sets `run.readyReport`, `parkedFor: 'ready'`, `parkedAt` and clears `mailedAt`, like a
  drafts park (no slot, `settle()` holds it only to its card existing) but never matched by
  `draftsDecided`. The run waits on `waitsOnReview`; approve, a rework, drop or a retry end
  it quietly and the publish run then claims the sub-job. An approved `forward {sub, note}`
  action (pinned to `{at:'round', ref: ready.receiptId}`, refused while `answering`; a `rework`
  of a parked step is refused in its favour) writes a `sub.thread` message (`askAgent`,
  `via: 'planner'`, `sentAt: null`) and the runner mails
  it (`deliverThread`, `threadMail`), setting `mailedAt` (the run is working again). In the
  wrangler conversation a forwards-only card (`forward: true`, no prose) is one line, and its
  approval stamps `forwarded: [{sub, message}]`, so `public/job-talk.js` draws the session's
  answers from `sub.thread` right after it. The
  agent answers with `reply {text, shots?, run?}` (parks again; tree and round unchanged) or
  a fresh `ready`: round n+1, `receiptId` `<run>#n`, the old round kept in `sub.earlier`.
  Pasted images are copied into the round's folder and mailed as paths
  (`TODO(host-api mail:images)`). `ready.treeHash` (`git.js workingTreeHash`: `add -A` into a
  temp index, `write-tree`) is read by the tool handler at the receipt; `approve-code` is
  refused unless the `job-action` handler's fresh read matches (`TREE_MOVED` also queues a
  `retell` message). Code on Auto never parks.
- **An approval can carry words for later steps.** `approve-session` and `approve-code` take an
  optional `note` (a string, trimmed, at most 2,000 characters or refused; `job-store.js
  approvalNote`), kept as `sub.approvalNote` and recorded on the move, so the step's own history
  shows it. `job-prompts.js approvalNotesBlock` hands every note upstream of a sub-job (transitive
  `after`, `upstreamOf`) to each of its prompts as quoted JSON, capped at 8,000 characters like
  `humanOutputBlock`. A bulk release (a checkpoint switched to Auto) carries none and clears it.
  On the board Approve stays one click that sends no note; its caret (`approveSplitHtml`) opens a
  popup whose `[data-with-note]` button sends `[data-approve-note]`, and typed text holds back a tick's redraw.
- **New idea is a job that may start as a conversation** (`server/job-idea.js`, `public/job-idea.js`).
  Only the board's form sets `idea` (`job-create` `idea:true` → `job.idea.thread`); `create_job` never does.
  Its planning run either reports `plan` as any job's does, or `reply {text, suggest?:{title, plan}}`,
  which parks the run (`parkedFor: 'idea'`, no slot, like a ready park) until the human's `idea-reply`
  is mailed by the runner (`deliverIdea`, `ideaMail`). `accept-idea {messageId}` is pinned to the newest
  message: it applies the suggestion exactly as a plan receipt (Plan review still applies), and settle()
  then ends the parked run quietly because the job is no longer `inConversation`. A fresh planning run
  (a retry) reads the whole thread from its prompt, so `claim` marks unsent messages sent. The chat
  dialog redraws on ticks even with the cursor in its empty reply box; only new messages fade in.
- **What the agent leaves running is the agent's; tearing it down is ours** (`server/job-running.js`).
  `ready` (and a restarting `reply`) may carry `running: [{name, url?, pid?, stop?, log?}]`, the
  agent's own detached (`setsid`) dev server, database, worker; the extension never starts one. It is kept
  as `sub.running` (`items` with a probed `up`, `owed` for entries a later round dropped, `stopped` after a
  teardown). The runner's `sweepRunning` runs FIRST each tick (so before cleanup removes the worktree a
  `stop` command runs in, and at boot): it tears down `dueTeardown` (owed, plus everything once
  `holdsRunning` is false: approve, drop, cancel, replan, cleanup, retry), probes the rest, and writes only
  when up/down flips. Teardown kills the pid's group (just the pid if it does not lead one; never our own
  process), runs each `stop` in the worktree, then checks the URLs stopped answering, and NEVER fails an
  approval: a leftover is `stopped.still`, drawn amber. Code on Auto owes everything at once. Logs reads only
  from under the worktree or the proof inbox (symlinks resolved). `restart-running` mails the parked session
  via `askAgent` (`kind: 'restart'`); `stop-running` just owes. The bar and dot are `public/job-running.js`.
- **A PR's `show` list is answered with proof, not claims** (`server/job-evidence.js`).
  The implementer saves files into one inbox per sub-job (`$JOB_EVIDENCE`, given in
  its prompt and granted as `addDirs`); the `ready` receipt names them per check
  (`shots`, `run` or `couldNot`), `job-store.js _proofOf` refuses a receipt that
  leaves a `show` item out and copies exactly the named files, sniffed by magic
  bytes and capped at 5 MB, into `round-<n>`. `ready.checks` stays plain strings
  (history and the old list read it); the proof lives beside it as `ready.proof`.
  The board gets bytes only as `job-evidence` frames (thumbnails via `sips`), cached
  in `public/job-proof.js`. A sub-job with `show` items reports `ready` even with
  Code on Auto (`leavesUncommitted`), so the proof is kept.
- **Fast-forward main never blocks a sub-job** (`server/job-main.js`). The global
  `settings.updateMain` ("Keep local main updated", on by default; a job's old `updateMain` is
  ignored) is handed to cleanup by the runner, and the update returns, never throws: a clean
  checkout on the base merges `--ff-only`, one on another branch gets `git fetch origin
  <base>:<base>`, and a dirty or diverged one (or any git error) becomes a notice in
  `job.mainNotices`, one per checkout path (`noteMain` merges sub-jobs and clears it on a later
  success). Each notice offers the fixes `resolutionsFor` allows (rebase & push, move commits to a
  branch, stash & update). `retry-main` and `resolve-main` only flag it; the runner's `tendMain`
  acts on the next tick, finished or paused jobs included: it spawns the fix's session (a plain
  one in the checkout, briefed by `resolvePrompt` with only that fix) inside the tick so no
  `pendingLaunch` is in flight, then clears the notice once local `<base>` equals origin's.
  A notice nothing is retrying or resolving (`job-state.js mainWaiting`) is a Needs you ask
  beside the stage roll-up, never part of it: `jobNeedsYou`, `jobLabel` ("Local main behind",
  even on a Delivered job) and `plateAsk` all read it, below any step's own ask.
- **A Codex job's sandbox is the manifest's `codexPolicy` hook** (host API 1.12),
  next to `skillsFor` and gated the same way (`runForSession`). Its context
  carries the façade as `ext`, not `host`. A job with no `sandbox` field (one
  saved before it) answers `undefined`, which is core's lock. `writableDirs`
  reach spawn as `addDirs` (`job-runtime.js writableDirsFor`), Codex only and
  never under Full access, and a folder missing on this machine is dropped,
  because core refuses a missing one and fails the launch. The form's
  "Launches" line (`public/job-sandbox.js`) mirrors `CODEX_POLICY`, so change
  them together.
- **New job's model picker is `public/model-picker.js` over `public/model-plates.js`.** It owns no form state: it reports `{ agent, model, effort }` through `onChange` into hidden inputs, so `form.onsubmit` and the `job-create` payload are untouched, and creating a job saves `settings.usualPick`. `describe()` must never invent a version from an alias (gap 18 in `docs/PORTING.md`). A galaxy plate is exactly one rAF loop, stopped by `dispose()`/re-render; art colours are fixed, chrome is board variables, except Claude's cabinet and ticket, whose launch-page near-black/ivory follows core's `body.light`. Each Claude plate declares its own noise filters (`fx()`), so plates never share an SVG id.
- **A theme is one `public/themes.js` entry, one `[data-theme="<id>"]` block of `--jt-*` tokens in
  `jobs.css` and its id in `public/theme-ids.js`** (which the server schema also reads, and whose
  `migrateTheme` turns a saved `backdrop`/top-level `plateArt` into `theme`/`themeOptions`; every board
  from before themes gets `DEFAULT_THEME`, Wrangler, and `migrateJobs` resets a version-5 file's Space
  to Wrangler once, so Space is only ever an active choice).
  `themes.test.js` holds every block to Space's token set, so never style a theme by excluding another
  (`:not([data-theme…])`) or read a `--jt-*` token Space does not set. `applyViewTheme` stamps
  `data-theme` (and `data-scheme="dark"` for a forced-dark theme) on `#jobs` and every dialog on
  `<body>`; a theme's `mount` is its only live art, so a theme without one runs no animation loop.
  Theme-only options live in `settings.themeOptions[id]` and must be listed in the server schema.
  The picker (`public/theme-picker.js`) is a radio list of themes beside a captioned preview, and saves
  each choice at once; Save settings never sends the theme. A theme draws no picture of its own: the
  preview is the real masthead and plates in its tokens (`public/theme-preview.js`), with their buttons
  and links turned to spans and the whole picture `inert`, so it never reads or acts as a control.
- **What's new is `public/updates.js`'s `UPDATES`, oldest first.** A bigger release appends `{ id, date, title, body }` (our own copy; optional `icon`, `tone`, `figure`, `anim`); every unseen one opens in one run, oldest first, and closing it records them all under `updatesSeen`. A first-run reader gets the intro instead, and closing that counts every current update seen, so an id must never be reused.
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
- `AW_REPO=<npm ci'd wrangler checkout> scripts/boot-smoke.sh` boots that wrangler
  on a fresh data dir and free port with this checkout copied in as
  `extensions/jobs`, then runs `scripts/dev-smoke.mjs`, which exits 1 on any
  failed expectation (quarantine, missing frame or tool). CI runs it last.
- `.github/workflows/sync-next.yml` merges every push to `main` into the
  long-lived `next` branch as a bot merge commit. On a conflict it fails and its
  job summary lists the files: merge `main` into `next` locally (`--no-ff` on
  `next`, resolve, `npm test`) and push the merge commit straight to `next`,
  after which the next run, or a manual `workflow_dispatch`, finds nothing to
  do. **Never land it through a PR**: the merge button remembers squash from
  feature PRs, and a squash keeps `main` out of `next`'s ancestry, so every
  later run conflicts again on files already resolved (the run's summary names
  any such squashed commit).
