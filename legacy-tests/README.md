Test suites copied from agent-wrangler's `job-system` branch that import the
wrangler core and cannot run here yet — see `docs/PORTING.md`, "Tests", for how
each one ports. They are `.mjs` on purpose: the wrangler's leaf-import scanner
(`server/extensions/external.js`) walks every own `*.js` file, `job-runtime.test.js`
imports `./session-manager.js`, and one match quarantines the whole extension.
Rename a suite back to `.test.js` when it moves into `server/` or `public/`.
