import { isWriteSub, placeOf } from './jobs-schema.js';

export const reportedFiles = (jobs) => [...new Set((jobs || []).flatMap((j) => (j.subJobs || [])
  .filter((s) => isWriteSub(s) && placeOf(s) === 'file' && typeof s.result?.url === 'string' && s.result.url.startsWith('/'))
  .map((s) => s.result.url)))];

// The host decides what may be opened: only a path registered here, under the
// `files:view` consent. Registration is idempotent and re-run each tick, so a
// restart that forgets the host's in-memory set is healed on the next one.
export function allowFiles(host, jobs, seen = new Set()) {
  if (!host?.files?.allow) return;
  for (const path of reportedFiles(jobs)) {
    if (seen.has(path)) continue;
    try { host.files.allow(path); seen.add(path); } catch (e) { host.log?.('files.allow failed', e); }
  }
}
