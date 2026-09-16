// The installed extension's entry point: the wrangler imports `index.js` from
// <DATA_DIR>/extensions/jobs/ and reads the default export. Everything lives in
// server/manifest.js — see its header for why nothing else may import this file.
export { dir } from './server/manifest.js';
export { default } from './server/manifest.js';
