import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { runFile } from './job-github.js';

// Proof the agent captured for a Show me item (docs: "See it working"). The
// agent writes into one INBOX per sub-job; when its `ready` receipt lands the
// store copies exactly the files the receipt names into a folder per round, so a
// later round (a rework) can neither overwrite nor lose what an earlier one
// showed. Only the receipt's own bytes are kept: a file left in the inbox that no
// receipt named never reaches the board.
//
// TODO(host-api spawn env): the agent is told this folder as `$JOB_EVIDENCE` in
// its prompt, but spawn() takes no `env`, so it is an instruction to export the
// variable rather than one the session starts with.
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const THUMB_PX = 320;
const KINDS = [
  { mime: 'image/png', exts: ['.png'], magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'], magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', exts: ['.gif'], magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'video/webm', exts: ['.webm'], magic: [0x1a, 0x45, 0xdf, 0xa3] },
];
export const EVIDENCE_EXTENSIONS = KINDS.flatMap((k) => k.exts);
// A bare file name, never a path: the agent names files, and a name is only ever
// joined onto a folder this module chose.
export const evidenceName = (n) => typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n) && EVIDENCE_EXTENSIONS.includes(path.extname(n).toLowerCase());

const rootOf = (jobId, subId) => path.join(DATA_DIR, 'evidence', jobId, subId);
export const inboxDir = (jobId, subId) => path.join(rootOf(jobId, subId), 'inbox');
export const roundDir = (jobId, subId, round) => path.join(rootOf(jobId, subId), `round-${round}`);
export const ensureInbox = (jobId, subId) => { const dir = inboxDir(jobId, subId); fs.mkdirSync(dir, { recursive: true }); return dir; };

// What the bytes ARE, not what the name claims: a renamed text file is refused.
export function sniffKind(bytes) {
  return KINDS.find((k) => k.magic.every((b, i) => bytes[i] === b)) || null;
}

// Copy every file a receipt's proof names into this round's folder and return
// the proof with each shot resolved to what the board needs. Throws, naming the
// file, so the agent can fix it and report again; nothing is half-kept because
// the caller persists only if this returns.
export function adoptEvidence({ jobId, subId, round, proof }) {
  const inbox = inboxDir(jobId, subId);
  const dest = roundDir(jobId, subId, round);
  const copied = new Map();
  const take = (file) => {
    if (copied.has(file)) return copied.get(file);
    const from = path.join(inbox, file);
    let st;
    try { st = fs.lstatSync(from); } catch { throw new Error(`${file} is not in $JOB_EVIDENCE (${inbox}); save it there first`); }
    if (!st.isFile()) throw new Error(`${file} must be a regular file`);
    if (st.size > EVIDENCE_MAX_BYTES) throw new Error(`${file} is over ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB; capture a smaller one`);
    const bytes = fs.readFileSync(from);
    const kind = sniffKind(bytes);
    if (!kind || !kind.exts.includes(path.extname(file).toLowerCase())) throw new Error(`${file} is not a PNG, JPEG, GIF or WebM file`);
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, file), bytes);
    const got = { mime: kind.mime, at: Math.round(st.mtimeMs) };
    copied.set(file, got);
    return got;
  };
  return proof.map((p) => ({
    text: p.text,
    ...(p.note ? { note: p.note } : {}),
    ...(p.run ? { run: p.run } : {}),
    ...(p.couldNot ? { couldNot: p.couldNot } : {}),
    ...(p.shots ? { shots: p.shots.map((s) => { const o = typeof s === 'string' ? { file: s } : s; return { ...o, ...take(o.file) }; }) } : {}),
  }));
}

// A thumbnail for the board's grid: macOS `sips` (the wrangler runs on the
// reviewer's own Mac), cut once and kept beside the original. A kind sips cannot
// read, or no sips at all, answers null and the client draws a placeholder; the
// full file stays one click away. Video is never thumbnailed.
export async function thumbnailOf({ jobId, subId, round, file, run = runFile }) {
  if (!evidenceName(file)) return null;
  const dir = roundDir(jobId, subId, round);
  const from = path.join(dir, file);
  if (!fs.existsSync(from) || file.toLowerCase().endsWith('.webm')) return null;
  const thumbs = path.join(dir, 'thumbs');
  const out = path.join(thumbs, `${path.basename(file, path.extname(file))}.jpg`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(thumbs, { recursive: true });
    try { await run('sips', ['-s', 'format', 'jpeg', '-Z', String(THUMB_PX), from, '--out', out]); } catch { return null; }
  }
  try { return { mime: 'image/jpeg', bytes: fs.readFileSync(out) }; } catch { return null; }
}

export function readEvidence({ jobId, subId, round, file }) {
  if (!evidenceName(file) || !Number.isInteger(round) || round < 1) return null;
  try {
    const bytes = fs.readFileSync(path.join(roundDir(jobId, subId, round), file));
    const kind = sniffKind(bytes);
    return kind ? { mime: kind.mime, bytes } : null;
  } catch { return null; }
}
