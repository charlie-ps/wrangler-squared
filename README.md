# Wrangler²

The Agent Wrangler **automated jobs** system as an installable
[extension](https://github.com/PortSwigger/agent-wrangler).

A job starts from an outcome. A planning session turns it into an ordered set of
PRs (and, where a step is not a repository change, an agent session on this
machine), grouped under Jira stories where the work is tracked in Jira; work
that has no ticket gets no story and never waits for one. Each step runs as its own short-lived agent session in
a dedicated worktree, submits a `job_report` receipt and stops; the wrangler
watches the PR, drives CI repairs, merges when the gates are satisfied, watches
the post-merge runs and cleans up. Humans decide at the review points — plan,
code, merge — and make the seven **moves** when something goes wrong; agents
never change the plan.

## Status

Functionally complete against host API **1.4.0**, the release of agent-wrangler
that added the worktree, `addDirs`, `taskId` and PR-automation spawn options
this extension depends on. Every feature the in-core system had is either wired
through the extension `host` façade or is one of the open host-API gaps listed in
**`docs/PORTING.md`**, which is the map: what came from where, what stands in
for what, and which gap blocks which feature. `grep -rn 'TODO(host-api' server
public` is the live list of gaps.

## Install

Requires an agent-wrangler on `main` (host API `^1.4.0`). In the wrangler's
Extensions tab, install from this repository's git URL, consent to the
capabilities disclosed in `package.json`'s `wranglerExtension` block, then
restart the wrangler. The extension asks for `sessions:read`, `sessions:spawn`,
`sessions:archive`, `sessions:wake`, `board:rebuild` and `board:broadcast`.

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
