# Wrangler²

The Agent Wrangler **automated jobs** system, being ported out of the wrangler
core into an installable extension.

A job starts from an outcome. A planning session turns it into Jira stories and
an ordered set of PRs (and, where a step is not a repository change, an agent
session on this machine). Each step runs as its own short-lived agent session in
a dedicated worktree, submits a `job_report` receipt and stops; the wrangler
watches the PR, drives CI repairs, merges when the gates are satisfied, watches
the post-merge runs and cleans up. Humans decide at the review points — plan,
code, merge — and make the seven **moves** when something goes wrong; agents
never change the plan.

## Status

Rough shape. The pure modules (schema, store, moves, prompts, GitHub and comment
handling, deploy inference, runner) are ported verbatim from agent-wrangler's
`job-system` branch; the session-facing runtime is rewritten over the extension
host API with every gap marked. See **`docs/PORTING.md`** for the file map, the
host-API gaps that block each feature, and the ordered work list.

## Install

In the wrangler's Extensions tab, install from this repository's git URL and
consent to the disclosed capabilities, then restart the wrangler. For development,
drop or symlink a checkout at `<AW_DATA_DIR>/extensions/jobs` instead.

Requires an agent-wrangler that serves host API `^1.0.0` (the extensions API
branch, see `AGENTS.md`).
