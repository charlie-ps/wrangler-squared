# Wrangler²

The Agent Wrangler **automated jobs** system as an installable
[extension](https://github.com/PortSwigger/agent-wrangler).

A job starts from an outcome. A planning session turns it into an ordered set of
PRs (and, where a step is not a repository change, an agent session on this
machine, or a human task where no agent can act at all), grouped under Jira
stories where the work is tracked in Jira; work
that has no ticket gets no story and never waits for one. Each step runs as its own short-lived agent session in
a dedicated worktree, submits a `job_report` receipt and stops; the wrangler
watches the PR, drives CI repairs, merges when the gates are satisfied, watches
the post-merge runs and cleans up. Humans decide at the review points — plan,
code, merge — and make the seven **moves** when something goes wrong; agents
never change the plan.

When a Job is created it can stay Unassigned, use an active Task, or create a
new Task. Every agent session launched for that Job uses the same Task and its
shared memory. Archiving that Task stops its active sessions; restore it before
retrying the Job so later sessions do not lose the Task context.

## Status

Functionally complete against host API **1.8.0**: 1.4 added the worktree,
`addDirs`, `taskId` and PR-automation spawn options this extension depends on,
1.6 the `usage:read` and `sessions:bill` capabilities behind the per-job price,
1.7 the `view` badge that puts the needs-you count on the rail button, and 1.8 the client `api.openSession` the Jobs view opens a step's card with. Every feature the in-core system had is either wired
through the extension `host` façade or is one of the open host-API gaps listed in
**`docs/PORTING.md`**, which is the map: what came from where, what stands in
for what, and which gap blocks which feature. `grep -rn 'TODO(host-api' server
public` is the live list of gaps.

## Install

Requires an agent-wrangler on `main` (host API `^1.8.0`). In the wrangler's
Extensions tab, install from this repository's git URL, consent to the
capabilities disclosed in `package.json`'s `wranglerExtension` block, then
restart the wrangler. The extension asks for `sessions:read`, `sessions:spawn`,
`sessions:archive`, `sessions:bill`, `tasks:read`, `tasks:write`, `usage:read`,
`board:rebuild` and `board:broadcast`.

Adding Task support widens the extension's requested capabilities. Updating an
existing installation therefore requires fresh consent in the Extensions tab;
a development copy with older consent is quarantined until it is reinstalled.
The host currently groups Task creation with rename and session assignment under
the broad `tasks:write` capability, although this extension uses it only to
create the Task requested in the New job form.

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
