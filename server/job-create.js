import { jobInputSchema, line } from './jobs-schema.js';
import { generateTitle } from './job-title.js';
import { runHeadlessClaude } from './headless-claude.js';
import { runnerFor } from './jobs.js';

// "Something changed, poke the runner": shared by the control handlers and the
// create_job tool so a started job launches planning without waiting for the
// next sweep.
export const kick = (host) => runnerFor(host).tick();

// One create path for the New idea form (`job-create`) and an agent's
// `create_job`: validate, settle the Task, create, optionally start, rebuild,
// kick. A throw means nothing was created; each caller reports it its own way
// (a broadcast for the form, an MCP error for the tool).
//
// The form sends only a description, so the job is created under a fallback
// title and Haiku's replaces it after the fact: naming never delays or fails a
// create. Its spend is billed to the planning card when one is already up.
export function makeCreateJob({ run = runHeadlessClaude } = {}) {
  const retitle = async (job, host) => {
    const { title, liveSessionId } = await generateTitle(job.intent, { run });
    if (!title || !host.stores.jobs.retitle(job.id, job.title, title)) return;
    const sid = host.stores.jobs.get(job.id)?.runs.findLast((r) => r.sessionId)?.sessionId;
    await host.rebuild();
    if (sid && liveSessionId) host.sessions.bill(sid, liveSessionId);
  };
  // `idea`: made from New idea, so planning may talk it through first (job-idea.js).
  // Only the board's form sets it; an agent's create_job plans straight away.
  return async (host, { job: raw, newTaskName, start, idea = false }) => {
    const input = jobInputSchema.parse(raw);
    let taskId = input.taskId;
    if (newTaskName !== undefined) {
      if (taskId) throw new Error('Choose an existing task or create a new one, not both');
      if (typeof newTaskName !== 'string') throw new Error('Enter a task name of up to 180 characters on one line');
      const name = newTaskName.trim();
      if (!name) throw new Error('Enter a name for the new task');
      if (!line.safeParse(name).success) throw new Error('Enter a task name of up to 180 characters on one line');
      taskId = host.tasks.create({ name }).id;
    } else if (taskId) {
      const task = host.tasks.get(taskId);
      if (!task || task.archived) throw new Error('The selected task is no longer available');
    }
    // The job keeps its own copies: a staged file is single-use and pruned after a
    // week, and every spawn of the job needs the same pictures.
    const kept = [];
    for (const name of input.images) {
      if (host.images.keep(name)) kept.push(name);
      else { for (const k of kept) host.images.remove(k); throw new Error('An attached image is no longer available. Attach it again.'); }
    }
    const job = host.stores.jobs.create({ ...input, taskId }, idea ? { idea: { thread: [] } } : {});
    if (start) host.stores.jobs.action(job.id, 'start', {});
    await host.rebuild();
    if (start) kick(host).catch((e) => host.log('job-create tick failed', e));
    if (!raw?.title) retitle(job, host).catch((e) => host.log('job title generation failed', e));
    return job;
  };
}
