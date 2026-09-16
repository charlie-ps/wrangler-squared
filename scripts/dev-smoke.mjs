#!/usr/bin/env node
// Smoke-test a RUNNING dev wrangler that has this extension installed (see
// docs/PORTING.md "Running it for real"):
//   AW_REPO=<wrangler checkout> node scripts/dev-smoke.mjs <port>
// Over the control WS: the `extensions` announcement, graph.extensions[].jobs
// status, graph.jobs, then a `job-create` (backlog only — starting one would
// launch a real, billed planning session) read back on the next graph. Over
// /mcp: tools/list as a fake caller, plus get_job_context and an invalid
// job_report, which is where this repo's zod meets the wrangler's.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const port = Number(process.argv[2]);
if (!port) { console.error('usage: node scripts/dev-smoke.mjs <port>'); process.exit(2); }
const repo = path.resolve((process.env.AW_REPO || '~/IdeaProjects/agent-wrangler').replace(/^~/, os.homedir()));
const { WebSocket } = await import(pathToFileURL(path.join(repo, 'node_modules/ws/wrapper.mjs')).href);

const ws = new WebSocket(`ws://localhost:${port}/ws`);
const frames = [];
const next = (pred, ms = 8000) => new Promise((res, rej) => {
  const hit = frames.find(pred); if (hit) return res(hit);
  const t = setTimeout(() => rej(new Error('timed out waiting for a frame')), ms);
  ws.on('message', function h(d) { const m = JSON.parse(d); if (pred(m)) { clearTimeout(t); ws.off('message', h); res(m); } });
});
ws.on('message', (d) => frames.push(JSON.parse(d)));
await new Promise((r) => ws.on('open', r));

const ann = await next((m) => m.type === 'extensions');
console.log('extensions announcement:', JSON.stringify(ann.list), 'host API', ann.version);
const g1 = await next((m) => m.type === 'graph');
const ext = g1.graph.extensions.find((e) => e.id === 'jobs');
console.log('graph.extensions.jobs:', JSON.stringify({ enabled: ext?.enabled, bootEnabled: ext?.bootEnabled, quarantine: ext?.quarantine, handlerTypes: ext?.handlerTypes, external: ext?.external }));
console.log('graph.jobs:', JSON.stringify({ jobs: g1.graph.jobs?.jobs?.length, settings: g1.graph.jobs?.settings }));

const before = g1.graph.jobs?.jobs?.length ?? 0;
ws.send(JSON.stringify({ type: 'job-create', start: false, job: { title: 'Smoke test job', intent: 'Created by scripts/dev-smoke.mjs; safe to delete.' } }));
const g2 = await next((m) => m.type === 'graph' && (m.graph.jobs?.jobs?.length ?? 0) > before);
const job = g2.graph.jobs.jobs.at(-1);
console.log('job-create landed:', JSON.stringify({ id: job.id, stage: job.stage, title: job.title }));
ws.send(JSON.stringify({ type: 'job-action', id: job.id, action: 'cancel-job' }));
const g3 = await next((m) => m.type === 'graph' && m.graph.jobs.jobs.find((j) => j.id === job.id)?.cancelledAt);
console.log('cancel-job landed:', JSON.stringify({ stage: g3.graph.jobs.jobs.find((j) => j.id === job.id).stage }));
const errs = frames.filter((m) => m.type === 'error');
if (errs.length) console.log('control errors:', JSON.stringify(errs));
ws.close();

// MCP, as a session the wrangler does not know (advisory identity → no run bound).
const mcp = async (body) => {
  const res = await fetch(`http://localhost:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-AW-Session': 'smoke-test-caller' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) });
  return res.json();
};
const list = await mcp({ method: 'tools/list', params: {} });
const names = (list.result?.tools || []).map((t) => t.name);
console.log('mcp tools/list has:', ['job_report', 'get_job_context', 'job_name_branch', 'spawn_session'].map((n) => `${n}=${names.includes(n)}`).join(' '));
const ctx = await mcp({ method: 'tools/call', params: { name: 'get_job_context', arguments: {} } });
console.log('get_job_context:', JSON.stringify(ctx.result?.structuredContent ?? ctx.error));
const bad = await mcp({ method: 'tools/call', params: { name: 'job_report', arguments: { runId: 'run_nope', report: { kind: 'blocked' } } } });
console.log('job_report (invalid, exercises cross-copy zod):', JSON.stringify(bad.result ?? bad.error).slice(0, 300));
