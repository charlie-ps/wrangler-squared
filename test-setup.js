import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Loaded via `node --test --import ./test-setup.js` so it runs before any test
// file in every subprocess. server/data-dir.js resolves DATA_DIR from AW_DATA_DIR
// at import time, so redirecting it here is what stops a JobStore() constructed
// in a test from reading or writing the real ~/.agent-wrangler/jobs.json. Same
// shape as agent-wrangler's server/test-setup.js, for the same reason.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrangler-squared-test-'));
process.env.AW_DATA_DIR = dataDir;
process.on('exit', () => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});
