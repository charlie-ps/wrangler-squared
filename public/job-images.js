import { imageSources, sourceToFrame, imageMimeOf } from './clipboard-images.js';
import { applyTheme } from './themes.js';

export const MAX_JOB_IMAGES = 8;

export const blobOf = ({ mime, dataBase64 }) => {
  const bin = atob(dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A nested modal on <body>: Escape closes only the top one, so enlarging a
// picture does not also close the dialog it was opened from.
export function openZoom(src, label, doc = globalThis.document) {
  const zoom = doc.createElement('dialog');
  zoom.className = 'job-image-zoom';
  applyTheme(zoom);
  zoom.setAttribute('aria-label', label);
  const img = doc.createElement('img');
  img.src = src;
  img.alt = label;
  zoom.appendChild(img);
  zoom.addEventListener('click', () => zoom.close());
  zoom.addEventListener('close', () => zoom.remove());
  doc.body.appendChild(zoom);
  zoom.showModal();
  return zoom;
}

// New job's image tray. An image is uploaded the moment it lands (`stage` is the
// client's api.images.stage, resolving the server-minted name the job is created
// with) and shown from a local object URL, so the thumbnail never waits on the
// server. `busy()` is what holds Start planning back: a job created while a
// picture is still travelling would silently lose it.
export function createJobImages({ root, field = root, input, attach, fileInput, stage, onChange = () => {}, frameOf = sourceToFrame, document: doc = globalThis.document }) {
  const tray = root.querySelector('.job-images-tray');
  const panel = root.querySelector('.job-images-panel');
  const countEl = root.querySelector('.job-images-count');
  const errorEl = root.querySelector('.job-images-error');
  let items = [];
  let seq = 0;
  // Sources still being decoded: they hold a slot and block planning before a tile exists.
  let converting = 0;
  let disposed = false;

  const showError = (text) => { errorEl.textContent = text; errorEl.hidden = !text; };

  function render() {
    tray.textContent = '';
    items.forEach((item, i) => {
      const li = doc.createElement('li');
      li.className = `job-image${item.name ? '' : ' uploading'}`;
      const thumb = doc.createElement('button');
      thumb.type = 'button';
      thumb.className = 'job-image-thumb';
      thumb.title = `Enlarge ${item.filename}`;
      thumb.setAttribute('aria-label', `Enlarge image ${i + 1}, ${item.filename}`);
      const img = doc.createElement('img');
      img.src = item.url;
      img.alt = '';
      // HEIC and TIFF are converted by the server, and the browser cannot draw them.
      img.addEventListener('error', () => { img.hidden = true; });
      thumb.appendChild(img);
      thumb.addEventListener('click', () => openZoom(item.url, item.filename, doc));
      const num = doc.createElement('span');
      num.className = 'job-image-num';
      num.textContent = String(i + 1);
      const spin = doc.createElement('span');
      spin.className = 'job-image-spinner';
      spin.setAttribute('role', 'status');
      spin.setAttribute('aria-label', 'Uploading');
      const drop = doc.createElement('button');
      drop.type = 'button';
      drop.className = 'job-image-remove';
      drop.title = 'Remove';
      drop.setAttribute('aria-label', `Remove image ${i + 1}`);
      drop.textContent = '×';
      drop.addEventListener('click', () => remove(item));
      const caption = doc.createElement('span');
      caption.className = 'job-image-name';
      caption.textContent = item.filename;
      caption.title = item.filename;
      li.append(thumb, num, spin, drop, caption);
      tray.appendChild(li);
    });
    panel.classList.toggle('has-images', items.length > 0);
    tray.hidden = !items.length;
    countEl.textContent = `${items.length} of ${MAX_JOB_IMAGES}`;
    attach.disabled = items.length >= MAX_JOB_IMAGES;
    onChange();
  }

  function remove(item) {
    items = items.filter((x) => x !== item);
    URL.revokeObjectURL(item.url);
    render();
  }

  async function upload(source) {
    const filename = source.file?.name || 'Pasted image';
    const item = { id: ++seq, filename, name: null, url: '' };
    let blob;
    converting++;
    onChange();
    try {
      blob = blobOf(await frameOf(source));
    } catch (e) {
      if (!disposed) showError(`${filename}: ${e?.message || 'Could not read that image.'}`);
      return;
    } finally {
      converting--;
      if (!disposed) onChange();
    }
    if (disposed) return;
    item.url = URL.createObjectURL(blob);
    items.push(item);
    render();
    try {
      const { name } = await stage(blob);
      if (disposed || !items.includes(item)) return;
      item.name = name;
    } catch (e) {
      if (disposed || !items.includes(item)) return;
      items = items.filter((x) => x !== item);
      URL.revokeObjectURL(item.url);
      showError(`${filename}: ${e?.message || 'Upload failed.'}`);
    }
    render();
  }

  // Paste, drop and the Attach button all arrive here as a DataTransfer-shaped
  // thing. Anything in it that is not an image is named rather than ignored, so a
  // dropped PDF is not mistaken for a dropped screenshot.
  function take(dt) {
    const { sources } = imageSources(dt);
    const rejected = Array.from(dt?.files || []).filter((f) => !imageMimeOf(f)).map((f) => f.name || 'unnamed file');
    const room = Math.max(0, MAX_JOB_IMAGES - items.length - converting);
    const chosen = sources.slice(0, room);
    const skipped = sources.length - chosen.length;
    const problems = [];
    if (rejected.length) problems.push(`${rejected.join(', ')} ${rejected.length === 1 ? 'is not an image' : 'are not images'}`);
    if (skipped) problems.push(`${plural(skipped, 'image was', 'images were')} skipped — a job holds ${MAX_JOB_IMAGES}`);
    showError(problems.join('. '));
    for (const source of chosen) upload(source);
    return sources.length > 0 || rejected.length > 0;
  }

  input.addEventListener('paste', (e) => {
    // Plain text keeps pasting normally: only a clipboard that holds an image is taken over.
    if (!imageSources(e.clipboardData).sources.length) return;
    e.preventDefault();
    take(e.clipboardData);
  });
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  field.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); field.classList.add('dragging'); } });
  field.addEventListener('dragleave', (e) => { if (!field.contains(e.relatedTarget)) field.classList.remove('dragging'); });
  field.addEventListener('drop', (e) => {
    field.classList.remove('dragging');
    if (!hasFiles(e)) return;
    e.preventDefault();
    take(e.dataTransfer);
  });
  attach.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { take({ files: Array.from(fileInput.files || []) }); fileInput.value = ''; });
  render();

  return {
    names: () => items.filter((i) => i.name).map((i) => i.name),
    busy: () => converting > 0 || items.some((i) => !i.name),
    // Pending uploads are dropped on the floor: the dialog they belong to is gone.
    dispose() {
      disposed = true;
      for (const i of items) URL.revokeObjectURL(i.url);
      items = [];
    },
  };
}

export const imagesPanelHtml = (max = MAX_JOB_IMAGES) => `<div class="job-images-panel"><ul class="job-images-tray" hidden></ul><div class="job-images-bar"><button type="button" class="job-images-attach">Attach</button><span class="job-images-hint">or paste / drop images</span><span class="job-images-count">0 of ${max}</span></div><input type="file" accept="image/*" multiple hidden></div><p class="job-images-error" role="alert" hidden></p>`;
