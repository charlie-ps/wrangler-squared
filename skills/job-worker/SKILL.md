---
name: job-worker
description: Use when this session is a Wrangler automated-job step (job_report is in your tools) — the bounded-step protocol: work, PR, report, stop.
---

# Job worker

You are one step of a Wrangler automated job. Your prompt names the single step
to do. Do it, submit its `job_report` receipt, then stop. Everything else —
concurrency, ordering, review gates, polling — belongs to Wrangler, which is
watching this job while you work.

## Stay inside your step

- **Don't merge**, and don't watch CI after pushing. Wrangler polls the PR,
  drives repairs and merges when the gates are satisfied.
- **Don't spawn sessions or agents, and don't schedule wake-ups.** A later step
  gets its own session with its own prompt.
- **Don't do a later step's work.** If your step turns out to need something the
  plan didn't cover, report blocked and say so — that is the outlet, not
  improvisation.

## The receipt is the only thing that advances the job

Terminal prose does nothing. Nothing happens until you call `job_report` with
the `runId` from your prompt and the receipt kind it names.

- **Checks are bullets, a few words each** — "Build passed", "Tests passed",
  "Expired links rejected". Normally one to three. Write them the way you'd
  update another developer: commands, paths, logs and counts stay in the
  transcript unless a result is unreadable without them. Add detail only for a
  real limitation or acceptance criterion.
- **Never claim a check you did not perform.** A check you couldn't run is a
  blocked receipt, not an optimistic bullet.
- **Blocked is one sentence**: `{kind:"blocked", summary:"…"}`. If you can see
  which move the human should make, name it —
  `move:"fix-here"|"split-out"|"new-ticket"|"reorder"|"drop"|"mark"|"accept-red"`. It is a
  suggestion; the human decides.
- Save your files before reporting: a successful report ends the run.
- A report that failed on a connection error is **safe to retry identically**.
- Call `get_job_context` if you have lost the job, the plan or your own step.
- Keep your final terminal output under 8 short lines — nobody reads it unless
  something went wrong.

## Working in a worktree (PR steps)

- **If your prompt says to leave the changes uncommitted, do exactly that.** The
  human reads the working tree on the board before anything is committed, and a
  later step commits, pushes and opens the PR. No commit, no push, no PR, no
  branch rename: report `ready` with what you verified.
- Your worktree branch is a **placeholder**. Before pushing, name it in *this
  repository's* convention: read its CLAUDE.md / AGENTS.md / CONTRIBUTING for a
  stated rule, and look at existing remote branches and recently merged PRs
  (`git branch -r`, `gh pr list --state merged`) for the pattern actually in
  use. Rename it **only** with the `name_branch` tool — never `git branch -m`,
  which leaves Wrangler's record (and the PR observer matching on it) behind.
  Never reuse an existing branch name, and never work on main/master.
- Fetch before editing. Commit with the repo's own convention, prefixed with the
  sub-job's Jira key when it has one (a ticketless sub-job's prompt says so; then
  follow the convention's ticketless form). End the commit message and the PR
  description with exactly this line:
  `Made with Agent Wrangler and the charlie-ps/wrangler-squared extension`.
  Exclude secrets and unrelated or generated files.
- Push explicitly to your worktree branch on origin; never rely on an inherited
  upstream.
- **Look for an existing PR for the branch before creating one**, so a retried
  step doesn't open a duplicate.

## Planning writes

- Use a preset place (jira, slack, confluence, artifact, file, url) whenever
  one fits. Anything else is `place:{type:"other", name, ref?}`: a `write` is
  one free-text instruction (`text`), or a session `make`s something there.
- Writes are off review by default (the job's `reviewWrites`). Set
  `review:true` only on a write you judge risky — something public, or hard to
  undo; your `true` holds even when the job's default is off. Story fields are
  reviewed with the write that creates the story, not with the plan.

## Write steps (Jira, Slack, Confluence, other places)

- Make exactly the writes your prompt lists, reading each place first: the
  ticket's status and comments, the channel's recent messages, the page or the
  space it goes in. Answer every one in the receipt: `written`, `already` (it
  was at or past the target, or the same post or page is already there — never
  post twice), or `failed` with the place's own error message. Give `url`, the
  permalink, for whatever you posted or created.
- A write the place refuses is a `failed` result, not a blocked receipt, and
  never something to work around; blocked is for when you cannot reach Jira,
  Slack or Confluence at all.
- A Jira create sets every field it lists, exactly as given; dropping one Jira
  will not take is a workaround, so that create is `failed`.
- An `other` place (`name`, and `where` if given): do exactly its one
  instruction there with whatever MCP tool or CLI reaches it, and report
  `written` with a `url` if the result has one. If nothing you have reaches
  that place, report `failed` with the tool's own error verbatim — never
  substitute another place.

## Session steps with outputs

- If your prompt lists outputs, make each one where it says and report every
  one in `completed`: `{id, url, title?}` with its link (a file's absolute
  path), or `{id, missing:"one line why"}` if you could not. A receipt that
  leaves one out is refused. An output in an `other` place may be a URL or an
  absolute path.
- Publish every output normally even if it is reviewed: the human reviews it
  after it exists, and there is no draft step.
