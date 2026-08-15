const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let state = {
  products: [],
  filter: 'all',
  jobRunning: false,
  currentId: null,
  selected: new Set(),
  backgroundRemoval: null,
  watermark: null,
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}

async function uploadProductPdf(file) {
  const res = await fetch('/api/product-pdf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}

async function uploadWatermarkLogo(file) {
  const res = await fetch('/api/watermark/logo', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function renderProductPdf(pdf = {}) {
  const status = $('#productPdfStatus');
  const clear = $('#clearProductPdf');
  status.classList.toggle('selected', !!pdf.selected);
  status.textContent = pdf.selected ? `✓ ${pdf.name} (${formatBytes(pdf.size)})` : 'No PDF selected — uploads will be blocked';
  status.title = pdf.selected ? pdf.name : 'Choose the brochure that should be attached to every product';
  clear.classList.toggle('hidden', !pdf.selected);
}

function toast(msg, kind = 'ok', ms = 3000) {
  const el = document.createElement('div');
  el.className = `t ${kind}`;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------- rendering ----------------
function renderPills(counts) {
  const c = counts;
  $('#statusPills').innerHTML = [
    ['Total', c.total],
    ['Images', `${c.images?.done || 0}/${c.total}`],
    ['SEO', `${c.seo?.done || 0}/${c.total}`],
    ['Uploaded', `${c.uploaded?.done || 0}/${c.total}`],
  ]
    .map(([k, v]) => `<span class="pill">${k} <b>${v}</b></span>`)
    .join('');
}

function renderBackgroundRemovalSummary(backgroundRemoval = {}) {
  state.backgroundRemoval = backgroundRemoval;
  const enabled = backgroundRemoval.settings?.enabled === true;
  const ready = backgroundRemoval.engine?.environmentReady === true;
  const modelCached = backgroundRemoval.engine?.modelCached === true;
  const status = $('#backgroundRemovalStatus');
  status.classList.toggle('enabled', enabled && ready);
  status.classList.toggle('warning', enabled && !ready);
  status.textContent = enabled
    ? ready
      ? `On · u2netp${modelCached ? '' : ' · first run downloads model'}`
      : 'Setup required'
    : 'Off';
  status.title = enabled
    ? ready
      ? `Local CPU background removal enabled for ${backgroundRemoval.settings.applyTo === 'primary' ? 'the primary photo' : 'all photos'}`
      : 'The isolated rembg Python environment is missing'
    : 'Background removal is disabled; persistent source images are unchanged';
}

function renderWatermarkSummary(watermark = {}) {
  state.watermark = watermark;
  const enabled = watermark.settings?.enabled === true;
  const mode = watermark.settings?.mode || 'text';
  const status = $('#watermarkStatus');
  status.classList.toggle('enabled', enabled);
  status.textContent = enabled ? `On · ${mode}` : 'Off';
  status.title = enabled
    ? `${mode} watermark enabled for ${watermark.settings.applyTo === 'primary' ? 'the primary photo' : 'all photos'}`
    : 'Watermarking is disabled; uploads use the existing image workflow';
}

function renderImageAiSummary(imageAi = true) {
  state.imageAi = Boolean(imageAi);
  const enabled = state.imageAi;
  const status = $('#imageAiStatus');
  const checkbox = $('#toggleImageAi');
  if (checkbox) checkbox.checked = enabled;
  if (status) {
    status.classList.toggle('enabled', enabled);
    status.textContent = enabled ? 'On' : 'Off';
    status.title = enabled
      ? 'AI image regeneration enabled: primary photo will be recreated with AI'
      : 'AI image regeneration disabled: real downloaded source photo is used directly';
  }
}

function renderChips(cfg) {
  const key = (name, on) => `<span class="chip ${on ? 'on' : 'off'}">${name} ${on ? '✓' : '✗'}</span>`;
  const backgroundRemovalEnabled = cfg.backgroundRemoval?.settings?.enabled === true;
  const watermarkEnabled = cfg.watermark?.settings?.enabled === true;
  const imageAiEnabled = cfg.imageAi !== false;
  $('#configChips').innerHTML =
    `<span class="chip">img: ${cfg.imageProvider}</span>` +
    `<span class="chip">seo: ${cfg.deepseekModel}</span>` +
    key('deepseek', cfg.keys.deepseek) +
    key(cfg.imageProvider, cfg.keys[cfg.imageProvider]) +
    key('session', cfg.sessionExists) +
    key('PDF', cfg.productPdf?.selected) +
    `<span class="chip ${backgroundRemovalEnabled ? 'on' : ''}">background: ${backgroundRemovalEnabled ? 'u2netp CPU' : 'off'}</span>` +
    `<span class="chip ${watermarkEnabled ? 'on' : ''}">watermark: ${watermarkEnabled ? cfg.watermark.settings.mode : 'off'}</span>` +
    `<span class="chip ${imageAiEnabled ? 'on' : ''}">ai-images: ${imageAiEnabled ? 'on' : 'off'}</span>`;
  renderProductPdf(cfg.productPdf);
  renderBackgroundRemovalSummary(cfg.backgroundRemoval || {});
  renderWatermarkSummary(cfg.watermark || {});
  renderImageAiSummary(imageAiEnabled);
}

const badge = (s, label) =>
  `<span class="badge ${['done', 'error', 'skipped'].includes(s) ? s : ''}">${label}</span>`;

function passesFilter(p) {
  if (state.filter === 'all') return true;
  return p.status[state.filter] !== 'done' && p.status[state.filter] !== 'skipped';
}

function escapeHtml(s = '') {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderGrid() {
  const items = state.products.filter(passesFilter);
  $('#count').textContent = `${items.length} product${items.length === 1 ? '' : 's'}`;
  $('#empty').classList.toggle('hidden', state.products.length > 0);
  $('#grid').innerHTML = items
    .map((p) => {
      const name = (p.seo && p.seo.name) || p.name;
      const specN = Object.keys(p.seo?.specs || p.specs || {}).length;
      const photoCount = p.localImages?.length || p.imageUrls?.length || 0;
      const hasImg = p.status.images === 'done' || photoCount > 0;
      const backgroundRemovalEnabled = state.backgroundRemoval?.settings?.enabled === true;
      const watermarkEnabled = state.watermark?.settings?.enabled === true;
      const uploadProcessingEnabled = backgroundRemovalEnabled || watermarkEnabled;
      const fallbackImage = p.aiImages?.length ? `/media/ai/${p.id}` : `/media/original/${p.id}/1`;
      const thumbSource = uploadProcessingEnabled ? `/media/upload-preview/${p.id}/1` : fallbackImage;
      const thumb = hasImg
        ? `<img class="thumb" loading="lazy" src="${thumbSource}" ` +
          `onerror="this.onerror=null;this.src='${fallbackImage}'" />`
        : `<div class="thumb empty">no image</div>`;
      const sel = state.selected.has(p.id);
      return `<div class="card ${sel ? 'selected' : ''}" data-id="${p.id}">
        <input type="checkbox" class="sel" data-selid="${p.id}" ${sel ? 'checked' : ''} title="select" />
        ${specN ? `<span class="specn">${specN} specs</span>` : ''}
        ${thumb}
        ${photoCount > 1 ? `<span class="photo-count">${photoCount} photos</span>` : ''}
        <div class="card-body">
          <div class="card-name">${escapeHtml(name)}</div>
          <div class="card-meta">
            <span class="price">₹${p.price || '—'}${p.unit ? '/' + p.unit : ''}</span>
            <span class="badges">
              ${backgroundRemovalEnabled ? badge('done', 'BG') : ''}${watermarkEnabled ? badge('done', 'WM') : ''}${badge(p.status.images, 'IMG')}${badge(p.status.seo, 'SEO')}${badge(p.status.uploaded, 'UP')}
            </span>
          </div>
        </div>
      </div>`;
    })
    .join('');
  updateSelbar();
}

function updateSelbar() {
  const n = state.selected.size;
  $('#selbar').classList.toggle('hidden', n === 0);
  $('#selCount').textContent = `${n} selected`;
  const visible = state.products.filter(passesFilter);
  $('#selectAll').checked = visible.length > 0 && visible.every((p) => state.selected.has(p.id));
}

async function refresh() {
  const s = await api('GET', '/api/status');
  state.products = s.products || [];
  // drop selections for products that no longer exist
  const ids = new Set(state.products.map((p) => p.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  renderPills(s.counts);
  renderChips(s.config);
  renderGrid();
  setJob(!!s.job, s.job);
}

function setJob(running, name) {
  state.jobRunning = running;
  $$('.toolbar .btn, #modal .btn, #backgroundRemovalModal .btn, #backgroundRemovalModal .fbtn, #watermarkModal .btn, #watermarkModal .fbtn').forEach((b) => (b.disabled = running));
  $('#productPdfFile').disabled = running;
  $('#clearProductPdf').disabled = running;
  $('#watermarkLogoFile').disabled = running;
  $('#jobState').textContent = running ? `running: ${name || ''}` : '';
}

// ---------------- actions ----------------
const ACTIONS = {
  login: () => api('POST', '/api/login'),
  import: () => api('POST', '/api/import', { file: $('#importFile').value.trim() }),
  scrape: () =>
    api('POST', '/api/scrape', {
      urls: [$('#scrapeUrl').value.trim()].filter(Boolean),
      limit: Number($('#scrapeLimit').value) || 0,
      mode: $('#scrapeMode').value,
    }),
  catalog: () =>
    api('POST', '/api/scrape-catalog', {
      urls: [$('#catalogUrl').value.trim()].filter(Boolean),
      limit: Number($('#catalogLimit').value) || 0,
    }),
  repairspecs: () => api('POST', '/api/repair-specs', {}),
  single: () => api('POST', '/api/scrape-single', { url: $('#singleUrl').value.trim() }),
  images: () => api('POST', '/api/images', {}),
  seo: () => api('POST', '/api/seo', {}),
  upload: () => api('POST', '/api/upload', { group: $('#uploadGroup').value.trim() }),
  skiplive: () => api('POST', '/api/skip-live', {}),
  testseo: () => api('POST', '/api/test/seo', {}),
  testimage: () => api('POST', '/api/test/image', {}),
  runall: () => api('POST', '/api/runall', {}),
};

document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    const act = actBtn.dataset.act;
    if (act === 'single' && !$('#singleUrl').value.trim()) return toast('Paste a product URL first', 'err');
    if (act === 'catalog' && !$('#catalogUrl').value.trim())
      return toast('Paste a seller category page URL first', 'err');
    try {
      await ACTIONS[act]();
      setJob(true, act);
      toast(`${act} started`);
    } catch (err) {
      toast(err.message, 'err', 5000);
    }
    return;
  }

  // card checkbox toggles selection (don't open modal)
  const cb = e.target.closest('.sel');
  if (cb) {
    e.stopPropagation();
    toggleSelect(cb.dataset.selid, cb.checked);
    return;
  }

  const card = e.target.closest('.card');
  if (card) return openDetail(card.dataset.id);

  const fbtn = e.target.closest('[data-filter]');
  if (fbtn) {
    state.filter = fbtn.dataset.filter;
    $$('#filters .fbtn').forEach((b) => b.classList.toggle('active', b === fbtn));
    renderGrid();
  }
});

function toggleSelect(id, on) {
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  $(`.card[data-id="${id}"]`)?.classList.toggle('selected', on);
  updateSelbar();
}

$('#selectAll').addEventListener('change', (e) => {
  const visible = state.products.filter(passesFilter);
  if (e.target.checked) visible.forEach((p) => state.selected.add(p.id));
  else visible.forEach((p) => state.selected.delete(p.id));
  renderGrid();
});
$('#selClear').addEventListener('click', () => {
  state.selected.clear();
  renderGrid();
});
$('#selDelete').addEventListener('click', async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} product(s) from the app? (does not touch IndiaMART)`)) return;
  try {
    const r = await api('POST', '/api/products/delete', { ids });
    state.selected.clear();
    toast(`Deleted ${r.deleted}`);
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
});

$('#clearLog').addEventListener('click', () => ($('#log').innerHTML = ''));

// ---------------- detail modal ----------------
async function openDetail(id) {
  state.currentId = id;
  const { product: p } = await api('GET', `/api/products/${id}`);
  const seo = p.seo || {};
  $('#edName').value = seo.name || p.name || '';
  $('#edMetaTitle').value = seo.metaTitle || '';
  $('#edMetaDesc').value = seo.metaDescription || '';
  $('#edKeywords').value = Array.isArray(seo.keywords) ? seo.keywords.join(', ') : seo.keywords || '';
  $('#edDesc').value = seo.description || p.description || '';
  $('#edSpecs').value = JSON.stringify(seo.specs || p.specs || {}, null, 2);
  const gallery = $('#imgOriginalGallery');
  const localCount = p.localImages?.length || 0;
  const originalCount = localCount || p.imageUrls?.length || 0;
  $('#originalCount').textContent = originalCount ? `(${originalCount} photos)` : '(none)';
  gallery.innerHTML = Array.from({ length: originalCount }, (_, index) =>
    `<img loading="lazy" src="/media/original/${id}/${index + 1}?t=${Date.now()}" ` +
      `alt="original photo ${index + 1}" />`,
  ).join('');

  const ai = $('#imgAi');
  const aiCount = p.aiImages?.length || 0;
  const hasAi = aiCount > 0;
  $('#aiFigure').style.display = hasAi ? '' : 'none';
  if (hasAi) {
    ai.src = `/media/ai/${id}?t=${Date.now()}`;
    ai.onerror = () => (ai.style.opacity = 0.15);
    ai.style.opacity = 1;
  }

  const backgroundRemovalSettings = state.backgroundRemoval?.settings;
  const backgroundRemovalEnabled = backgroundRemovalSettings?.enabled === true;
  const watermarkSettings = state.watermark?.settings;
  const watermarkEnabled = watermarkSettings?.enabled === true;
  const uploadProcessingEnabled = backgroundRemovalEnabled || watermarkEnabled;
  const uploadCount = aiCount
    ? aiCount + Math.max(0, localCount - Math.min(aiCount, localCount))
    : localCount;
  const previewFigure = $('#uploadPreviewFigure');
  previewFigure.classList.toggle('hidden', !uploadProcessingEnabled || uploadCount === 0);
  if (uploadProcessingEnabled && uploadCount > 0) {
    const summary = [];
    if (backgroundRemovalEnabled) {
      const scope = backgroundRemovalSettings.applyTo === 'primary' ? 'primary photo only' : 'all photos';
      summary.push(`u2netp CPU background · ${scope}`);
    }
    if (watermarkEnabled) {
      const scope = watermarkSettings.applyTo === 'primary' ? 'primary photo only' : 'all photos';
      const position = watermarkSettings.pattern === 'tile'
        ? 'tiled'
        : watermarkSettings.position.replaceAll('-', ' ');
      summary.push(`${watermarkSettings.mode} watermark · ${scope} · ${position} · ${watermarkSettings.opacity}% opacity`);
    }
    $('#uploadPreviewStatus').textContent = `(${summary.join(' + ')})`;
    $('#imgUploadPreviewGallery').innerHTML = Array.from({ length: uploadCount }, (_, index) =>
      `<img loading="lazy" src="/media/upload-preview/${id}/${index + 1}?t=${Date.now()}" ` +
        `alt="upload preview ${index + 1}" />`,
    ).join('');
  } else {
    $('#uploadPreviewStatus').textContent = '';
    $('#imgUploadPreviewGallery').innerHTML = '';
  }
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  $('#modal').classList.add('hidden');
  state.currentId = null;
}
$('#modalClose').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => e.target.id === 'modal' && closeModal());

$('#btnSaveSeo').addEventListener('click', async () => {
  const id = state.currentId;
  let specs = {};
  try {
    specs = JSON.parse($('#edSpecs').value || '{}');
  } catch {
    return toast('Specs is not valid JSON', 'err');
  }
  try {
    await api('PUT', `/api/products/${id}/seo`, {
      name: $('#edName').value,
      metaTitle: $('#edMetaTitle').value,
      metaDescription: $('#edMetaDesc').value,
      keywords: $('#edKeywords').value.split(',').map((s) => s.trim()).filter(Boolean),
      description: $('#edDesc').value,
      specs,
    });
    toast('SEO saved');
    await refresh();
  } catch (e) {
    toast(e.message, 'err');
  }
});

$('#btnReuploadDescription').addEventListener('click', async () => {
  const id = state.currentId;
  if (!id) return;
  const description = $('#edDesc').value.trim();
  if (!description) return toast('Add a description first', 'err');
  if (!confirm('Update the description on this existing live IndiaMART product? Photos and PDF will not be re-uploaded.')) {
    return;
  }
  try {
    // Persist the currently visible textarea first so unsaved dialog edits are
    // the exact text sent to IndiaMART.
    await api('PUT', `/api/products/${id}/seo`, { description });
    await api('POST', `/api/products/${id}/reupload-description`);
    setJob(true, 'description re-upload');
    toast('Description re-upload started');
    closeModal();
  } catch (e) {
    toast(e.message, 'err', 5000);
  }
});

$('#btnReuploadSpecs').addEventListener('click', async () => {
  const id = state.currentId;
  if (!id) return;
  let specs;
  try {
    specs = JSON.parse($('#edSpecs').value || '{}');
  } catch {
    return toast('Specs is not valid JSON', 'err');
  }
  if (!Object.keys(specs).length) return toast('Add at least one specification first', 'err');
  if (!confirm('Update specifications on this existing live IndiaMART product? Photos and PDF will not be re-uploaded.')) {
    return;
  }
  try {
    // Persist the currently visible Specs JSON first so the live update uses
    // edits the user made in this detail dialog, even without clicking Save.
    await api('PUT', `/api/products/${id}/seo`, { specs });
    await api('POST', `/api/products/${id}/reupload-specs`);
    setJob(true, 'specs re-upload');
    toast('Specifications re-upload started');
    closeModal();
  } catch (e) {
    toast(e.message, 'err', 5000);
  }
});

$('#btnUploadOne').addEventListener('click', async () => {
  try {
    await api('POST', '/api/upload', { ids: [state.currentId] });
    setJob(true, 'upload');
    toast('Upload started');
    closeModal();
  } catch (e) {
    toast(e.message, 'err');
  }
});

$$('[data-reset]').forEach((b) =>
  b.addEventListener('click', async () => {
    try {
      await api('POST', `/api/products/${state.currentId}/reset`, { stage: b.dataset.reset });
      const ep = b.dataset.reset === 'seo' ? '/api/seo' : '/api/images';
      await api('POST', ep, { ids: [state.currentId] });
      setJob(true, b.dataset.reset);
      toast(`Re-running ${b.dataset.reset}`);
      closeModal();
    } catch (e) {
      toast(e.message, 'err');
    }
  }),
);

// Reset a stage WITHOUT re-running it. Used for the upload stage, where a
// product wrongly left as "done" must become retryable without immediately
// starting another upload.
$$('[data-reset-only]').forEach((b) =>
  b.addEventListener('click', async () => {
    try {
      const stage = b.dataset.resetOnly;
      await api('POST', `/api/products/${state.currentId}/reset`, { stage });
      await refresh();
      toast(`${stage} status reset — nothing was uploaded`);
      closeModal();
    } catch (e) {
      toast(e.message, 'err');
    }
  }),
);

// ---------------- live logs (SSE) ----------------
function pushLog(level, text, time) {
  const el = document.createElement('div');
  el.className = `ln ${level}`;
  el.textContent = `${time || ''} ${text}`.trim();
  const log = $('#log');
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('line', (e) => {
    const l = JSON.parse(e.data);
    pushLog(l.level, l.text, l.time);
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data);
    if (j.state === 'start') setJob(true, j.name);
    if (j.state === 'done' || j.state === 'error') {
      setJob(false);
      toast(j.state === 'done' ? `${j.name} finished` : `${j.name} failed: ${j.error}`, j.state === 'done' ? 'ok' : 'err', 4000);
      refresh();
    }
  });
  es.onerror = () => setTimeout(connectSSE, 3000);
}

connectSSE();
refresh();
setInterval(() => !state.jobRunning && refresh(), 15000);

$('#productPdfFile').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    input.value = '';
    return toast('Please select a .pdf file', 'err');
  }
  if (file.size > 20 * 1024 * 1024) {
    input.value = '';
    return toast('PDF must be 20 MB or smaller', 'err');
  }
  try {
    input.disabled = true;
    const result = await uploadProductPdf(file);
    renderProductPdf(result.pdf);
    toast(`PDF selected: ${result.pdf.name}`);
    await refresh();
  } catch (error) {
    toast(error.message, 'err', 5000);
  } finally {
    input.disabled = state.jobRunning;
    input.value = '';
  }
});

$('#clearProductPdf').addEventListener('click', async () => {
  if (!confirm('Clear the shared PDF? Product uploads will be blocked until another PDF is selected.')) return;
  try {
    const result = await api('DELETE', '/api/product-pdf');
    renderProductPdf(result.pdf);
    toast('Shared PDF selection cleared');
    await refresh();
  } catch (error) {
    toast(error.message, 'err', 5000);
  }
});

// ---------------- local upload background removal ----------------
function populateBackgroundRemovalForm(backgroundRemoval) {
  const settings = backgroundRemoval.settings;
  const engine = backgroundRemoval.engine || {};
  $('#bgEnabled').checked = settings.enabled;
  $('#bgApplyTo').value = settings.applyTo;
  $('#bgModel').value = settings.model || 'u2netp';
  $('#bgEngineStatus').textContent = engine.environmentReady
    ? `✓ Isolated CPU environment ready · concurrency ${engine.concurrency} · ${engine.threads} threads`
    : 'Setup required: the isolated rembg Python environment was not found.';
  $('#bgModelStatus').textContent = engine.modelCached
    ? `✓ u2netp model cached locally (${formatBytes(engine.modelBytes)})`
    : 'u2netp model will download once on the first preview (approximately 4.6 MB).';
}

function closeBackgroundRemovalModal() {
  $('#backgroundRemovalModal').classList.add('hidden');
}

$('#openBackgroundRemoval').addEventListener('click', async () => {
  try {
    const result = await api('GET', '/api/background-removal');
    state.backgroundRemoval = result.backgroundRemoval;
    populateBackgroundRemovalForm(result.backgroundRemoval);
    $('#backgroundRemovalModal').classList.remove('hidden');
  } catch (error) {
    toast(error.message, 'err', 5000);
  }
});
$('#backgroundRemovalClose').addEventListener('click', closeBackgroundRemovalModal);
$('#backgroundRemovalCancel').addEventListener('click', closeBackgroundRemovalModal);
$('#backgroundRemovalModal').addEventListener('click', (event) => {
  if (event.target.id === 'backgroundRemovalModal') closeBackgroundRemovalModal();
});
$('#saveBackgroundRemoval').addEventListener('click', async () => {
  try {
    const result = await api('PUT', '/api/background-removal', {
      enabled: $('#bgEnabled').checked,
      applyTo: $('#bgApplyTo').value,
      model: 'u2netp',
    });
    state.backgroundRemoval = result.backgroundRemoval;
    renderBackgroundRemovalSummary(result.backgroundRemoval);
    closeBackgroundRemovalModal();
    toast(
      result.backgroundRemoval.settings.enabled
        ? 'Local u2netp CPU background removal enabled for future uploads'
        : 'Background-removal settings saved; removal is off',
    );
    await refresh();
  } catch (error) {
    toast(error.message, 'err', 5000);
  }
});

// ---------------- upload watermark settings ----------------
function renderWatermarkLogo(logo = {}) {
  const status = $('#watermarkLogoStatus');
  const clear = $('#clearWatermarkLogo');
  status.classList.toggle('selected', !!logo.selected);
  status.textContent = logo.selected ? `✓ ${logo.name} (${formatBytes(logo.size)})` : 'No image selected';
  status.title = logo.selected ? logo.name : 'Upload a PNG, JPEG, or WebP watermark image';
  clear.classList.toggle('hidden', !logo.selected);
}

function syncWatermarkMode() {
  const imageMode = $('#wmMode').value === 'image';
  $('#wmTextSection').classList.toggle('hidden', imageMode);
  $('#wmImageSection').classList.toggle('hidden', !imageMode);
}

function populateWatermarkForm(watermark) {
  const settings = watermark.settings;
  $('#wmEnabled').checked = settings.enabled;
  $('#wmMode').value = settings.mode;
  $('#wmText').value = settings.text;
  $('#wmApplyTo').value = settings.applyTo;
  $('#wmPattern').value = settings.pattern;
  $('#wmPosition').value = settings.position;
  $('#wmOpacity').value = settings.opacity;
  $('#wmRotation').value = settings.rotation;
  $('#wmMargin').value = settings.marginPercent;
  $('#wmTileSpacing').value = settings.tileSpacingPercent;
  $('#wmTextSize').value = settings.textSizePercent;
  $('#wmTextColor').value = settings.textColor;
  $('#wmFontFamily').value = settings.fontFamily;
  $('#wmFontWeight').value = String(settings.fontWeight);
  $('#wmBackgroundEnabled').checked = settings.backgroundEnabled;
  $('#wmBackgroundColor').value = settings.backgroundColor;
  $('#wmBackgroundOpacity').value = settings.backgroundOpacity;
  $('#wmBackgroundPadding').value = settings.backgroundPaddingPercent;
  $('#wmImageWidth').value = settings.imageWidthPercent;
  $('#wmQuality').value = settings.quality;
  renderWatermarkLogo(watermark.logo);
  syncWatermarkMode();
}

function watermarkFormSettings() {
  return {
    enabled: $('#wmEnabled').checked,
    mode: $('#wmMode').value,
    text: $('#wmText').value.trim(),
    applyTo: $('#wmApplyTo').value,
    pattern: $('#wmPattern').value,
    position: $('#wmPosition').value,
    opacity: Number($('#wmOpacity').value),
    rotation: Number($('#wmRotation').value),
    marginPercent: Number($('#wmMargin').value),
    tileSpacingPercent: Number($('#wmTileSpacing').value),
    textSizePercent: Number($('#wmTextSize').value),
    textColor: $('#wmTextColor').value,
    fontFamily: $('#wmFontFamily').value,
    fontWeight: Number($('#wmFontWeight').value),
    backgroundEnabled: $('#wmBackgroundEnabled').checked,
    backgroundColor: $('#wmBackgroundColor').value,
    backgroundOpacity: Number($('#wmBackgroundOpacity').value),
    backgroundPaddingPercent: Number($('#wmBackgroundPadding').value),
    imageWidthPercent: Number($('#wmImageWidth').value),
    quality: Number($('#wmQuality').value),
  };
}

function closeWatermarkModal() {
  $('#watermarkModal').classList.add('hidden');
}

$('#openWatermark').addEventListener('click', async () => {
  try {
    const result = await api('GET', '/api/watermark');
    state.watermark = result.watermark;
    populateWatermarkForm(result.watermark);
    $('#watermarkModal').classList.remove('hidden');
  } catch (error) {
    toast(error.message, 'err', 5000);
  }
});
$('#watermarkClose').addEventListener('click', closeWatermarkModal);
$('#watermarkCancel').addEventListener('click', closeWatermarkModal);
$('#watermarkModal').addEventListener('click', (event) => {
  if (event.target.id === 'watermarkModal') closeWatermarkModal();
});
$('#wmMode').addEventListener('change', syncWatermarkMode);

$('#wmRecommended').addEventListener('click', () => {
  $('#wmApplyTo').value = 'all';
  $('#wmPattern').value = 'single';
  $('#wmPosition').value = 'bottom-right';
  $('#wmOpacity').value = 32;
  $('#wmRotation').value = 0;
  $('#wmMargin').value = 3;
  $('#wmTileSpacing').value = 18;
  $('#wmTextSize').value = 4;
  $('#wmImageWidth').value = 18;
  $('#wmQuality').value = 92;
  $('#wmBackgroundEnabled').checked = true;
  $('#wmBackgroundOpacity').value = 30;
  $('#wmBackgroundPadding').value = 1;
  toast('Recommended starting values applied. Save settings when ready.');
});

$('#saveWatermark').addEventListener('click', async () => {
  try {
    const result = await api('PUT', '/api/watermark', watermarkFormSettings());
    state.watermark = result.watermark;
    renderWatermarkSummary(result.watermark);
    renderWatermarkLogo(result.watermark.logo);
    closeWatermarkModal();
    toast(result.watermark.settings.enabled ? 'Watermark enabled for future image uploads' : 'Watermark settings saved; watermark is off');
    await refresh();
  } catch (error) {
    toast(error.message, 'err', 5000);
  }
});

$('#watermarkLogoFile').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  const validExtension = /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!validExtension) {
    input.value = '';
    return toast('Select a PNG, JPEG, or WebP watermark image', 'err');
  }
  if (file.size > 5 * 1024 * 1024) {
    input.value = '';
    return toast('Watermark image must be 5 MB or smaller', 'err');
  }
  try {
    input.disabled = true;
    const result = await uploadWatermarkLogo(file);
    state.watermark = result.watermark;
    renderWatermarkLogo(result.watermark.logo);
    renderWatermarkSummary(result.watermark);
    toast(`Watermark image selected: ${result.watermark.logo.name}`);
  } catch (error) {
    toast(error.message, 'err', 5000);
  } finally {
    input.disabled = state.jobRunning;
    input.value = '';
  }
});

$('#clearWatermarkLogo').addEventListener('click', async () => {
  if (!confirm('Clear the selected watermark image? Active image watermarking will be turned off.')) return;
  try {
    const result = await api('DELETE', '/api/watermark/logo');
    state.watermark = result.watermark;
    $('#wmEnabled').checked = result.watermark.settings.enabled;
    renderWatermarkLogo(result.watermark.logo);
    renderWatermarkSummary(result.watermark);
    toast('Watermark image cleared');
  } catch (error) {
    toast(error.message, 'err', 5000);
  }
});

$('#toggleImageAi').addEventListener('change', async (event) => {
  const enabled = event.currentTarget.checked;
  try {
    const result = await api('PUT', '/api/image-settings', { ai: enabled });
    renderImageAiSummary(result.imageSettings.ai);
    toast(
      result.imageSettings.ai
        ? 'AI image regeneration enabled'
        : 'AI image regeneration disabled (using real source photos)',
    );
  } catch (error) {
    event.currentTarget.checked = !enabled;
    toast(error.message, 'err', 5000);
  }
});
