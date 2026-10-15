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
- **Blocked is one sentence**: `{kind:"blocked", summary:"…"}`. It goes to the
  human, who answers with Retry or by sending a change in through Request
  changes; you never name a move or change the plan.
- Save your files before reporting: a successful report ends the run (all but
  `drafts`, which waits for mail; see below).
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

- Every write names the session sub-job that makes it (`by`); never a PR or
  human sub-job. Group related writes under one session (a ticket, the page
  that links it and the message that links both are one session owning three
  writes), and a job whose whole outcome is writes is one or a few sessions.
- A write due at a milestone of other work gets a small session with
  `on:{sub, at}` owning it — e.g. moving the ticket to Done when the PR merges
  is a session `on:{sub:"<pr id>", at:"merged"}`. `on` is only ever a
  session's.
- `{<write id>.url}` may name a write the same session makes first, or one made
  by a session this one waits to finish (`after`, or `on` at `deployed`).
- Use a preset place (jira, slack, confluence, artifact, file, url) whenever
  one fits. Anything else is `place:{type:"other", name, ref?}`: a `write` is
  one free-text instruction (`text`), or a session `make`s something there.
- Writes are off review by default (the job's `reviewWrites`). Set
  `review:true` only on a write you judge risky — something public, or hard to
  undo; your `true` holds even when the job's default is off. Story fields are
  reviewed with the write that creates the story, not with the plan.

## Session steps with writes

- If your prompt lists writes, you own them: make each where it says, and
  answer every one in `completed` as
  `writes:[{id, outcome:"written"|"already"|"failed", url?, key?, from?, title?, error?}]`.
  A receipt that leaves one out is refused and names what is missing — fix it
  and report again.
- Read each place first: the ticket's status and comments, the channel's recent
  messages, the page or the space it goes in. `already` means it was at or past
  the target, or the same post or page is there — never post twice. Give
  `url`, the permalink, for whatever you posted or created; a created story
  gives its `key`.
- Make them in order: a write that links another of yours (`{<id>.url}`, named
  in your prompt as one you make first) comes after it, with that URL put in.
- A write the place refuses is a `failed` result with the place's own error,
  not a blocked receipt, and never something to work around. A Jira create
  sets every field it lists, exactly as given. An `other` place gets exactly
  its one instruction with whatever reaches it, or `failed` with the tool's
  own error — never a substitute place.
- An output you `make` is published normally even if it is reviewed: the human
  reviews it after it exists. Report its link (a file's absolute path), or
  `failed` with why.

## Drafts: reviewed writes

- If your prompt says review is on for some writes, do NOT make them. Do your
  work and any unreviewed writes, then send every reviewed one in one
  `{kind:"drafts", drafts:[{id, text?, title?, to?, comment?, where?, fields?}]}`
  receipt — each exactly as you would make it (a story's summary as `title`,
  with its `fields`).
- Drafts do not end your run. Wait, doing nothing else: mail arrives saying
  which writes to make, with their final text (the human may have edited
  them), and which were skipped. Read it with `read_mail` if it is only
  announced. Make exactly those, then send `completed` answering for every
  write still open; a skipped write needs no answer.
