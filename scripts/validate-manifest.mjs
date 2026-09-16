#!/usr/bin/env node
// Validate this extension against the REAL wrangler loader, the same way a boot
// would: discovery (id/dir-name check + the leaf-import scan), validateManifest,
// loadExtensions (name collisions, quarantine reasons) and buildHostApi
// (capability names + engines.wranglerApi against the served version).
//
//   AW_REPO=~/IdeaProjects/agent-wrangler-worktree-ext-api node scripts/validate-manifest.mjs
//
// AW_REPO must be a checkout of the extensions-API branch (docs/PORTING.md) with
// `semver` resolvable from it. Exits 1 on any refusal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.env.AW_REPO && path.resolve(process.env.AW_REPO.replace(/^~/, os.homedir()));
if (!repo || !fs.existsSync(path.join(repo, 'server/extensions/index.js'))) {
  console.error('Set AW_REPO to an agent-wrangler checkout that has server/extensions/index.js');
  process.exit(2);
}
// The loader's config-store reads DATA_DIR at import; point it somewhere harmless.
process.env.AW_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'wrangler-squared-validate-'));
const mod = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const { validateManifest, loadExtensions, CAPABILITIES } = await mod('server/extensions/index.js');
const { discoverExternal } = await mod('server/extensions/external.js');
const { buildHostApi } = await mod('server/host-api/index.js');
const { HOST_API_VERSION } = await mod('server/host-api/version.js');
// The core registries' names, so a collision shows up here rather than at boot.
// Read from the wrangler's own modules when they import cleanly, else skipped.
let coreToolNames = [], coreHandlerTypes = [];
try { coreToolNames = (await mod('server/mcp/tools/index.js')).TOOLS.map((t) => t.name); } catch (e) { console.warn('(core tool names unavailable:', e.message.split('\n')[0], ')'); }
try { coreHandlerTypes = (await mod('server/control/handlers/index.js')).CONTROL_HANDLERS.map((h) => h.type); } catch (e) { console.warn('(core handler types unavailable:', e.message.split('\n')[0], ')'); }

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let failed = false;
const fail = (msg) => { failed = true; console.error('✗', msg); };
const ok = (msg) => console.log('✓', msg);

// 1. Discovery: an extensions dir holding `jobs -> <this repo>`, exactly as an
//    install lays it out. Runs the leaf-import scan and the id/dir-name check.
//    A COPY, not a symlink: discovery keeps `dirent.isDirectory()` entries only,
//    and a symlink is not one — so a symlinked dev install is silently never
//    discovered (verified here; docs/PORTING.md "Running it for real").
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrangler-squared-ext-'));
const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).wranglerExtension;
fs.cpSync(root, path.join(extDir, declared.id), { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
const [found] = await discoverExternal({ dir: extDir, provenance: {} });
if (!found) fail('discoverExternal found nothing');
else if (found.quarantine) fail(`discovery quarantined: ${found.quarantine}`);
else ok(`discovered as "${found.id}" from ${extDir}`);

// 2. The manifest itself, against the declaration a human consents to.
const { default: manifest } = await import(pathToFileURL(path.join(root, 'server/manifest.js')).href);
try { validateManifest(manifest); ok('validateManifest'); } catch (e) { fail(e.message); }
if (manifest.id !== declared.id) fail(`manifest id "${manifest.id}" != package.json wranglerExtension.id "${declared.id}"`);
const undisclosed = (manifest.requires || []).filter((c) => !(declared.requires || []).includes(c));
if (undisclosed.length) fail(`manifest requires more than package.json discloses: ${undisclosed.join(', ')}`);
else ok('requires ⊆ disclosed requires');
for (const c of manifest.requires || []) if (!CAPABILITIES.has(c)) fail(`unknown capability ${c}`);

// 3. The loader, with the core names, so a tool/handler collision is visible.
const loaded = loadExtensions({ cfg: {}, builtin: [{ ...manifest, external: true }], coreToolNames, coreHandlerTypes });
const entry = loaded.list.find((e) => e.id === manifest.id);
if (!entry) fail('loadExtensions produced no entry');
else if (entry.quarantine) fail(`loadExtensions quarantined: ${entry.quarantine}`);
else ok(`loadExtensions: ${loaded.tools.length} tools, ${loaded.handlers.length} handlers, ${Object.keys(loaded.stores).length} store(s), skills [${entry.skills.join(', ')}], client ${loaded.clientManifest[0]?.client}, styles ${loaded.clientManifest[0]?.styles}`);

// 4. The façade: capability names and the declared range against the served version.
try {
  const host = buildHostApi({ id: manifest.id, requires: manifest.requires, range: manifest.engines?.wranglerApi, core: {}, rebuild: () => {}, broadcast: () => {}, archiveSession: () => {}, stores: {}, log: () => {} });
  ok(`buildHostApi: serves ${HOST_API_VERSION}, keys [${Object.keys(host).join(', ')}]`);
} catch (e) { fail(e.message); }

// 5. Store factory runs with the minimal bag the wrangler hands it.
try { const s = manifest.stores.jobs({ id: manifest.id, log: () => {} }); ok(`store factory → ${s.constructor.name} at ${s.file}`); } catch (e) { fail(`store factory threw: ${e.message}`); }

fs.rmSync(extDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
