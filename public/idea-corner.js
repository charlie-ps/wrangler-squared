import { esc } from './util.js';
import { ICONS } from './icons.js';

// The Jobs board's bottom-right "Have an idea?" corner. What is typed becomes a
// PUBLIC issue on the repo, filed by the reader's own gh login (server/handlers.js
// makeFeatureRequestHandlers), so the panel says so above the fields before
// anything is sent. Collapsed it is one quiet pill: no badge, pulse or pop-up.
// The draft outlives closing and every failure; only a sent idea clears it.
export const IDEA_REPO = 'charlie-ps/wrangler-squared';
const CLI_URL = 'https://cli.github.com';

export function createIdeaCorner({ send }) {
  const el = document.createElement('div');
  el.className = 'jobs-idea';
  el.setAttribute('aria-live', 'polite');
  // view: teaser | form | sending | done | auth | missing
  let view = 'teaser', login = null, error = '', issue = null, rid = null;
  const draft = { title: '', body: '' };
  const ask = (type, extra = {}) => {
    rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    send({ type, rid, ...extra });
  };
  const head = (h, p = '') => `<div class="jobs-idea-head"><span class="jobs-idea-bulb">${ICONS.idea}</span><div><h3>${h}</h3>${p ? `<p>${p}</p>` : ''}</div><button type="button" class="jobs-idea-close" data-idea="close" aria-label="Close" title="Close">${ICONS.x}</button></div>`;
  const as = () => (login ? `as @${esc(login)}` : '');
  const noticeText = () => `Anyone can read it on <a href="https://github.com/${IDEA_REPO}/issues" target="_blank" rel="noopener noreferrer">${IDEA_REPO}</a>, posted as ${login ? `<span class="jobs-idea-who">@${esc(login)}</span>` : 'your GitHub account'}. Leave out secrets, customer names and internal details.`;

  function render() {
    el.dataset.view = view;
    if (view === 'teaser') {
      el.innerHTML = `<button type="button" class="jobs-idea-teaser" data-idea="open"><span class="jobs-idea-bulb">${ICONS.idea}</span><span><b>Have an idea?</b><small>Help make Wrangler² better</small></span></button>`;
      return;
    }
    if (view === 'form' || view === 'sending') {
      const busy = view === 'sending' ? ' disabled' : '';
      el.innerHTML = `<form class="jobs-idea-panel" novalidate>
        ${head('What would make Jobs better?', 'A missing feature, a rough edge, a wild idea. Every request lands with the person who builds Jobs, and gets read.')}
        <div class="jobs-idea-notice" role="note">${ICONS.globe}<b>This becomes a public GitHub issue.</b><span>${noticeText()}</span></div>
        <label class="jobs-idea-field">What should it do?
          <input name="title" maxlength="120" placeholder="Let me retry one step of a job" required${busy}></label>
        <label class="jobs-idea-field">Why it would help <small>optional</small>
          <textarea name="body" maxlength="4000" placeholder="What were you trying to do when you wished for it?"${busy}></textarea></label>
        ${error ? `<p class="jobs-idea-error" role="alert">${esc(error)}</p>` : ''}
        <div class="jobs-idea-actions">
          <button class="primary" type="submit"${busy}>${busy ? `${ICONS.spin}Posting to GitHub…` : `${ICONS.next}Post`}</button>
          ${busy ? '' : '<button type="button" class="jobs-idea-text quiet" data-idea="close">Not now</button>'}
          <span class="jobs-idea-as">${as()}</span>
        </div></form>`;
      // Values set as properties, never spliced into markup: the draft is typed text.
      el.querySelector('[name=title]').value = draft.title;
      el.querySelector('[name=body]').value = draft.body;
      return;
    }
    if (view === 'done') {
      el.innerHTML = `<div class="jobs-idea-panel">${head('Thank you!')}
        <div class="jobs-idea-result"><span class="jobs-idea-badge ok">${ICONS.check}</span>
          <h3>Your idea is on the list</h3>
          <p>It's a public issue now, so you'll get GitHub notifications when it's discussed or shipped.</p>
          <a class="jobs-idea-issue" href="${esc(issue.url)}" target="_blank" rel="noopener noreferrer"><span class="num">#${esc(issue.number)}</span><span class="t">${esc(issue.title)}</span>${ICONS.link}</a>
        </div>
        <div class="jobs-idea-actions"><button type="button" class="jobs-idea-text" data-idea="again">${ICONS.plus}Send another</button><button type="button" class="jobs-idea-text quiet" data-idea="close">Close</button></div></div>`;
      return;
    }
    const missing = view === 'missing';
    const cmd = missing ? 'brew install gh && gh auth login' : 'gh auth login';
    el.innerHTML = `<div class="jobs-idea-panel">${head('One step before you post')}
      <div class="jobs-idea-result"><span class="jobs-idea-badge bad">${ICONS.terminal}</span>
        <h3>${missing ? 'The GitHub CLI isn’t installed' : 'The GitHub CLI isn’t signed in'}</h3>
        <p>${missing ? `Requests post through <span class="jobs-idea-who">gh</span> under your own GitHub account. Install it from <a class="jobs-idea-who" href="${CLI_URL}" target="_blank" rel="noopener noreferrer">cli.github.com</a>, then sign in:` : 'Requests post under your own GitHub account, so <span class="jobs-idea-who">gh</span> needs to know who you are. Run this in a terminal:'}</p>
        <div class="jobs-idea-cmd"><code>${esc(cmd)}</code><button type="button" data-idea="copy">Copy</button></div>
        <span class="jobs-idea-kept">Your draft is kept.</span>
      </div>
      <div class="jobs-idea-actions"><button class="primary" type="button" data-idea="retry">Try again</button><button type="button" class="jobs-idea-text quiet" data-idea="close">Not now</button></div></div>`;
  }

  function save() {
    const t = el.querySelector('[name=title]'), b = el.querySelector('[name=body]');
    if (t) draft.title = t.value;
    if (b) draft.body = b.value;
  }
  function go(next) { save(); view = next; render(); }
  // Opening (and Try again) asks who gh is signed in as, so a signed-out reader
  // learns before typing a whole essay; the form shows while that is answered.
  function open() { error = ''; go('form'); ask('feature-request-whoami'); el.querySelector('[name=title]')?.focus(); }
  function close() { rid = null; go('teaser'); el.querySelector('[data-idea=open]')?.focus(); }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-idea]');
    if (!b) return;
    const act = b.dataset.idea;
    if (act === 'open' || act === 'retry') open();
    else if (act === 'close') close();
    else if (act === 'again') { draft.title = ''; draft.body = ''; issue = null; open(); }
    else if (act === 'copy') {
      const text = el.querySelector('.jobs-idea-cmd code').textContent;
      navigator.clipboard?.writeText(text).then(() => { b.textContent = 'Copied'; }, () => {});
    }
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
    if (!draft.title.trim()) { el.querySelector('[name=title]').focus(); return; }
    error = '';
    go('sending');
    ask('feature-request', { title: draft.title.trim(), body: draft.body.trim() });
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view !== 'teaser' && view !== 'sending') { e.stopPropagation(); close(); } });

  // Every board tab gets every frame; only the one whose request it answers acts.
  function message(msg) {
    if (!msg.rid || msg.rid !== rid) return;
    rid = null;
    if (msg.event === 'feature-request-gh') {
      // Patched in place rather than re-rendered: the reader may already be typing.
      if (msg.login) {
        login = msg.login;
        if (view !== 'form') return;
        el.querySelector('.jobs-idea-as').textContent = as();
        el.querySelector('.jobs-idea-notice span').innerHTML = noticeText();
        return;
      }
      if (view !== 'form') return;
      if (msg.reason === 'missing' || msg.reason === 'auth') go(msg.reason);
      else { error = msg.error; go('form'); }
    } else if (msg.event === 'feature-request-created') {
      issue = { url: msg.url, number: msg.number, title: msg.title };
      draft.title = ''; draft.body = '';
      view = 'done'; render();
    } else if (msg.event === 'feature-request-failed') {
      const gh = msg.reason === 'missing' || msg.reason === 'auth';
      if (!gh) error = msg.error;
      view = gh ? msg.reason : 'form'; render();
    }
  }
  render();
  return { el, message };
}
