The two test suites copied from agent-wrangler's `job-system` branch that still
drive the wrangler core and so cannot run here as-is — see `docs/PORTING.md`,
"Tests", for how each one ports. `job-runtime.test.mjs` drove a real
`SessionManager` and wants rewriting against a fake `host`;
`jobs-integration.test.mjs` stood up the wrangler's HTTP/WS/MCP stack and is
replaced by manifest-level tests plus `scripts/validate-manifest.mjs`.

They are `.mjs` on purpose: the wrangler's leaf-import scanner
(`server/extensions/external.js`) walks every own `*.js` file, `job-runtime.test.js`
imports `./session-manager.js`, and one match quarantines the whole extension.
Rename a suite back to `.test.js` when it moves into `server/` or `public/` —
`npm test` picks a suite up by filename alone.

Already moved out: `jobs.test.mjs` → `server/jobs.test.js` and
`jobs-view.test.mjs` → `public/jobs-view.test.js`.
