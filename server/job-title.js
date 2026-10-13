import { runHeadlessClaude } from './headless-claude.js';

const TITLE_PROMPT = `The text on stdin is a human's description of a software job for an automated coding agent. Write a short title for it as it would appear on a work board: at most eight words, plain English, sentence case, naming the outcome. Output the title alone on one line: no quotes, no markdown, no trailing full stop, no preamble.`;

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '') || s.slice(0, n - 1)}…` : s;

// The job exists before Haiku answers, so it is born with this and keeps it if
// the model fails: the description's first line, cut on a word boundary.
export const fallbackTitle = (intent) => clip(squash(String(intent || '').split(/\r?\n/).find((l) => l.trim())), 80) || 'Untitled job';

export function parseTitle(text) {
  const first = String(text || '').split(/\r?\n/).find((l) => l.trim());
  const title = squash(first).replace(/^(\*\*)?title:?(\*\*)?\s*/i, '').replace(/^["'`*#\s]+|["'`*\s]+$/g, '').replace(/\.$/, '');
  return title ? clip(title, 180) : null;
}

// Never throws: a failed or unparseable run is a null title and the fallback stays.
export async function generateTitle(intent, { run = runHeadlessClaude } = {}) {
  const { text, liveSessionId, error } = await run(TITLE_PROMPT, intent).catch((e) => ({ error: e }));
  return { title: error ? null : parseTitle(text), liveSessionId: liveSessionId || null };
}
