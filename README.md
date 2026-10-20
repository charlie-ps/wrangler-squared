# Wrangler²

**A new way of working with AI.** Wrangler² breaks work into AI sessions and PRs,
provides proof that changes work, and allows you to get more done in parallel. It
installs as an [extension](https://github.com/PortSwigger/agent-wrangler) for
Agent Wrangler.

A job starts from an outcome. A planning session turns it into an ordered set of
PRs (and, where a step is not a repository change, an agent session on this
machine, or a human task where no agent can act at all), grouped under Jira
stories where the work is tracked in Jira; work
that has no ticket gets no story and never waits for one. Each step runs as its own short-lived agent session in
a dedicated worktree, submits a `job_report` receipt and stops; the wrangler
watches the PR, drives CI repairs, merges when the gates are satisfied, watches
the post-merge runs and cleans up. Humans decide at the review points — plan,
code, merge — and send an idea in through **Request changes** on any step
when something goes wrong; agents never change the plan.

A Codex job also saves a **sandbox** mode, chosen in the New job form's Sandbox
section and applied to every step through the manifest's `codexPolicy` hook
(host API 1.12): **Locked to worktree** keeps core's
`--sandbox workspace-write --ask-for-approval never`, **Auto-approve** (the
default for new jobs) launches `codex --approve-for-me` so a reviewer model can
let a step write outside its worktree, and **Full access** launches
`--dangerously-bypass-approvals-and-sandbox`. Extra writable folders (such as
`~/.docker`) are passed as `--add-dir` on every step unless the mode is Full
access. A folder that does not exist on this machine is skipped, because a
missing `--add-dir` would fail the launch. Only job sessions get the policy, and
Claude jobs ignore it because Claude has no OS sandbox. A job saved before this
existed stays locked.

When a Job is created it can stay Unassigned, use an active Task, or create a
new Task. A new Task from the New idea form starts under the Job's first line and is renamed to
the Job's generated title when it arrives (suffixed if another Task already has that name). Every agent session launched for that Job uses the same Task and its
shared memory. Archiving that Task stops its active sessions; restore it before
retrying the Job so later sessions do not lose the Task context.

Agents can create jobs too: any ordinary agent session gets a `create_job` tool
taking what the New job form takes (the description as `intent`, `repos`,
`agent`/`model`/`effort`, `sandbox`/`writableDirs`, an optional `taskId` or
`newTaskName`, and `start`).
It returns the `jobId`; without `start` the job waits in the backlog, and with it
planning still stops for a human to approve the plan. Job-step sessions do not
see the tool, so a job cannot start further jobs.

A **job spend limit** in Automation settings (its Automation tab, dollars, cents allowed;
$100 unless you change it, empty for none) caps what any one job may spend. A job's limit is that figure
times one plus the number of times it has been topped up, worked out live, so a
new figure reaches every job in flight: raise it and a job paused for budget
carries on, lower it and one already over pauses. A job that reaches its limit is
**paused for budget**: no new step, repair, replan, comment triage or mail to a
parked session starts, and every session of it that is working is interrupted
(one Escape per card per 15 seconds while it is still over). A plain Resume does
not lift it; **Add $X** in the job's dialog (the board's plate says only
"Paused for budget", never the limit) raises its limit by one more X and the
interrupted sessions are mailed to carry on. Spend is the usage scan's per-card
price with each live card's own price off the ~4s board graph folded in. An
interrupt lands between model turns: a single long reply is not cut mid-stream,
so a job can finish over its limit by up to one turn.

## Status

Functionally complete against host API **1.38.0**: 1.4 added the worktree,
`addDirs`, `taskId` and PR-automation spawn options this extension depends on,
1.6 the `usage:read` and `sessions:bill` capabilities behind the per-job price,
1.7 the `view` badge that puts the needs-you count on the rail button, 1.8 the client `api.openSession` the Jobs view opens a step's card with, 1.12 the `codexPolicy` hook behind a Codex job's sandbox mode, 1.25 the client `api.agents()` the New job form reads its models and efforts from, 1.27 the client `api.openDiff` behind Review code in Wrangler, and 1.31 the `images:keep` capability and `images` spawn option behind a job's attached images, and 1.38 the `files:view` capability and client `api.openFile` / `api.files` behind Open on a file place. Every feature the in-core system had is either wired
through the extension `host` façade or is one of the open host-API gaps listed in
**`docs/PORTING.md`**, which is the map: what came from where, what stands in
for what, and which gap blocks which feature. `grep -rn 'TODO(host-api' server
public` is the live list of gaps.

## Install

Requires an agent-wrangler on `main` (host API `^1.38.0`). In the wrangler's
Extensions tab, install from this repository's git URL, consent to the
capabilities disclosed in `package.json`'s `wranglerExtension` block, then
restart the wrangler. The extension asks for `sessions:read`, `sessions:spawn`,
`sessions:archive`, `sessions:bill`, `sessions:wake`, `sessions:interrupt`, `tasks:read`, `tasks:write`, `usage:read`,
`board:rebuild` and `board:broadcast`.

Adding Task support widens the extension's requested capabilities. Updating an
existing installation therefore requires fresh consent in the Extensions tab;
a development copy with older consent is quarantined until it is reinstalled.
The host currently groups Task creation with rename and session assignment under
the broad `tasks:write` capability, although this extension uses it only to
create the Task requested in the New job form or by `create_job`.

For development, **copy** (never symlink — discovery only sees real directories)
a checkout, `node_modules` included, to `<AW_DATA_DIR>/extensions/jobs` of a
run-dev wrangler and restart it. The directory name must be `jobs`, the
manifest `id`. `AGENTS.md` has the invariants and footguns.

## Develop

```
npm ci
npm test
AW_REPO=<agent-wrangler checkout> node scripts/validate-manifest.mjs
```

`npm test` runs the server and client suites under `node --test`, isolated from
`~/.agent-wrangler` by `test-setup.js`. The validate script runs the wrangler's
real loader over this repo: discovery, import scan, manifest validation and
host-API construction.

## Licence

Apache-2.0, see `LICENSE`. The job-system modules were ported from
agent-wrangler, which is also Apache-2.0; `NOTICE` carries the attribution and
`docs/PORTING.md` records what was copied verbatim and what was rewritten.
