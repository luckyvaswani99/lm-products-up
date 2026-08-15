import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log, logBus } from './logger.js';
import { Store } from './store.js';
import {
  runScrape,
  runScrapeCatalog,
  repairMissingSpecs,
  runScrapeSingle,
  deleteProducts,
  runImport,
  runImages,
  runSeo,
  runUpload,
  reuploadSpecs,
  reuploadDescription,
  skipLive,
  updateSeo,
  resetStage,
  status,
} from './pipeline.js';
import { login, isMarkedLoggedIn } from './browser/session.js';
import { testSeo } from './ai/seoContent.js';
import { testImage } from './images/aiImage.js';
import {
  SHARED_PRODUCT_PDF_MAX_BYTES,
  clearSharedProductPdf,
  getSharedProductPdfInfo,
  saveSharedProductPdf,
} from './sharedProductPdf.js';
import {
  WATERMARK_LOGO_MAX_BYTES,
  clearWatermarkLogo,
  getWatermarkState,
  saveWatermarkLogo,
  saveWatermarkSettings,
} from './watermark/settings.js';
import { saveBackgroundRemovalSettings } from './backgroundRemoval/settings.js';
import {
  assertBackgroundRemovalAvailable,
  getBackgroundRemovalState,
} from './backgroundRemoval/processor.js';
import { clearUploadPreviewCache, getUploadPreviewFile } from './images/watermarkPreview.js';
import { loadImageSettings, saveImageSettings } from './images/imageSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5199;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Ensure persistent image settings are loaded on startup
loadImageSettings();

// ---------- single-job runner so the UI can't start two at once ----------
const job = { name: null, startedAt: null };
function runJob(name, fn) {
  if (job.name) throw new Error(`busy: "${job.name}" is already running`);
  job.name = name;
  job.startedAt = Date.now();
  logBus.emit('job', { name, state: 'start' });
  Promise.resolve()
    .then(fn)
    .then(() => logBus.emit('job', { name, state: 'done' }))
    .catch((e) => {
      log.error(`${name}: ${e.message}`);
      logBus.emit('job', { name, state: 'error', error: e.message });
    })
    .finally(() => {
      job.name = null;
      job.startedAt = null;
    });
}

const ok = (res, data = {}) => res.json({ ok: true, ...data });
const fail = (res, e) => res.status(400).json({ ok: false, error: e.message || String(e) });

// ---------- data ----------
app.get('/api/status', async (_req, res) => {
  try {
    const s = await status();
    ok(res, { ...s, job: job.name, config: publicConfig() });
  } catch (e) {
    fail(res, e);
  }
});

function publicConfig() {
  const imageSettings = loadImageSettings();
  return {
    imageProvider: imageSettings.provider,
    imageAi: imageSettings.ai,
    deepseekModel: config.deepseek.model,
    supplier: config.supplier,
    productPdf: getSharedProductPdfInfo(),
    backgroundRemoval: getBackgroundRemovalState(),
    watermark: getWatermarkState(),
    keys: {
      deepseek: !!config.deepseek.apiKey,
      gemini: !!config.image.gemini.apiKey,
      openai: !!config.image.openai.apiKey,
      replicate: !!config.image.replicate.token,
    },
    sessionExists: isMarkedLoggedIn(),
  };
}

// ---------- shared product brochure ----------
app.get('/api/product-pdf', (_req, res) => ok(res, { pdf: getSharedProductPdfInfo() }));
app.post(
  '/api/product-pdf',
  express.raw({ type: 'application/pdf', limit: SHARED_PRODUCT_PDF_MAX_BYTES }),
  (req, res) => {
    try {
      if (job.name) throw new Error(`wait for "${job.name}" to finish before replacing the PDF`);
      let originalName = req.get('x-file-name') || 'brochure.pdf';
      try {
        originalName = decodeURIComponent(originalName);
      } catch {
        throw new Error('PDF filename could not be read');
      }
      const pdf = saveSharedProductPdf(req.body, originalName);
      log.ok(`Shared product PDF selected: ${pdf.name}`);
      ok(res, { pdf });
    } catch (e) {
      fail(res, e);
    }
  },
);
app.delete('/api/product-pdf', (_req, res) => {
  try {
    if (job.name) throw new Error(`wait for "${job.name}" to finish before clearing the PDF`);
    const pdf = clearSharedProductPdf();
    log.warn('Shared product PDF selection cleared.');
    ok(res, { pdf });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- AI image generation settings ----------
app.get('/api/image-settings', (_req, res) => {
  try {
    ok(res, { imageSettings: loadImageSettings() });
  } catch (e) {
    fail(res, e);
  }
});
app.put('/api/image-settings', (req, res) => {
  try {
    if (job.name) throw new Error(`wait for "${job.name}" to finish before changing AI image settings`);
    const imageSettings = saveImageSettings(req.body || {});
    log.ok(`AI image generation ${imageSettings.ai ? 'enabled' : 'disabled'}.`);
    ok(res, { imageSettings });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- local upload background removal ----------
app.get('/api/background-removal', (_req, res) => {
  try {
    ok(res, { backgroundRemoval: getBackgroundRemovalState() });
  } catch (e) {
    fail(res, e);
  }
});
app.put('/api/background-removal', (req, res) => {
  try {
    if (job.name) throw new Error(`wait for "${job.name}" to finish before changing background removal settings`);
    if (req.body?.enabled === true) assertBackgroundRemovalAvailable();
    saveBackgroundRemovalSettings(req.body || {});
    clearUploadPreviewCache();
    const backgroundRemoval = getBackgroundRemovalState();
    log.ok(
      `Local upload background removal saved (` +
        `${backgroundRemoval.settings.enabled ? `${backgroundRemoval.settings.model} CPU` : 'disabled'}).`,
    );
    ok(res, { backgroundRemoval });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- upload watermark ----------
app.get('/api/watermark', (_req, res) => {
  try {
    ok(res, { watermark: getWatermarkState() });
  } catch (e) {
    fail(res, e);
  }
});
app.put('/api/watermark', (req, res) => {
  try {
    if (job.name) throw new Error(`wait for "${job.name}" to finish before changing watermark settings`);
    const watermark = saveWatermarkSettings(req.body || {});
    clearUploadPreviewCache();
    log.ok(`Upload watermark settings saved (${watermark.settings.enabled ? watermark.settings.mode : 'disabled'}).`);
    ok(res, { watermark });
  } catch (e) {
    fail(res, e);
  }
});
app.post(
  '/api/watermark/logo',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'], limit: WATERMARK_LOGO_MAX_BYTES }),
  (req, res) => {
    try {
      if (job.name) throw new Error(`wait for "${job.name}" to finish before replacing the watermark image`);
      let originalName = req.get('x-file-name') || 'watermark-image';
      try {
        originalName = decodeURIComponent(originalName);
      } catch {
        throw new Error('Watermark image filename could not be read');
      }
      const watermark = saveWatermarkLogo(req.body, originalName);
      clearUploadPreviewCache();
      log.ok(`Watermark image selected: ${watermark.logo.name}`);
      ok(res, { watermark });
    } catch (e) {
      fail(res, e);
    }
  },
);
app.delete('/api/watermark/logo', (_req, res) => {
  try {
    if (job.name) throw new Error(`wait for "${job.name}" to finish before clearing the watermark image`);
    const watermark = clearWatermarkLogo();
    clearUploadPreviewCache();
    log.warn('Watermark image cleared; image watermarking was disabled if it was active.');
    ok(res, { watermark });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- media ----------
app.get(['/media/original/:id', '/media/original/:id/:index'], (req, res) => {
  const dir = config.imagesDir;
  const prefix = `${req.params.id}-`;
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((file) => {
          if (!file.startsWith(prefix)) return null;
          const match = file.slice(prefix.length).match(/^(\d+)\./);
          return match ? { file, index: Number(match[1]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index)
    : [];
  const requested = Math.max(1, Number(req.params.index) || 1);
  const selected = files.find((item) => item.index === requested);
  if (selected) return res.sendFile(path.join(dir, selected.file));
  res.status(404).end();
});
app.get('/media/ai/:id', (req, res) => {
  const file = path.join(config.aiImagesDir, `${req.params.id}.png`);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).end();
});
app.get(['/media/upload-preview/:id', '/media/upload-preview/:id/:index'], async (req, res) => {
  try {
    const store = await new Store().load();
    const product = store.get(req.params.id);
    if (!product) return res.status(404).end();
    const file = await getUploadPreviewFile(product, req.params.index);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    res.set('Cache-Control', 'no-store, max-age=0');
    return res.sendFile(path.resolve(file));
  } catch (error) {
    log.warn(`Upload preview failed for ${req.params.id}: ${error.message}`);
    return res.status(500).json({ ok: false, error: 'Could not render upload preview' });
  }
});

// ---------- actions ----------
app.post('/api/login', (_req, res) => {
  try {
    runJob('login', () => login());
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/scrape', (req, res) => {
  try {
    const { urls, limit, mode } = req.body || {};
    runJob('scrape', () => runScrape({ urls, limit, mode }));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/scrape-catalog', (req, res) => {
  try {
    const { urls, limit } = req.body || {};
    runJob('catalog', () => runScrapeCatalog({ urls, limit }));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/repair-specs', (_req, res) => {
  try {
    runJob('repair-specs', () => repairMissingSpecs());
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/scrape-single', (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) throw new Error('provide { url }');
    runJob('extract', () => runScrapeSingle(url));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/products/delete', async (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!ids.length) throw new Error('no ids provided');
    const r = await deleteProducts(ids);
    ok(res, r);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/import', (req, res) => {
  try {
    const { file } = req.body || {};
    if (!file) throw new Error('provide { file } path');
    runJob('import', () => runImport(file));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/images', (req, res) => {
  try {
    runJob('images', () => runImages(req.body || {}));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/seo', (req, res) => {
  try {
    runJob('seo', () => runSeo(req.body || {}));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/upload', (req, res) => {
  try {
    runJob('upload', () => runUpload(req.body || {}));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/test/seo', (_req, res) => {
  try {
    runJob('test-seo', async () => {
      const r = await testSeo();
      log.ok(`AI text OK — model "${r.model}", reply: "${r.reply}"`);
    });
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/test/image', (_req, res) => {
  try {
    runJob('test-image', async () => {
      const r = await testImage();
      log.ok(`AI image OK — provider "${r.provider}" (${r.model}), got ${r.bytes} bytes`);
    });
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/skip-live', (_req, res) => {
  try {
    runJob('skip-live', () => skipLive());
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/runall', (req, res) => {
  try {
    const body = req.body || {};
    runJob('run-all', async () => {
      if (body.urls?.length) await runScrape({ urls: body.urls, limit: body.limit });
      await runImages(body);
      await runSeo(body);
      await runUpload(body);
    });
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});

// ---------- per-product ----------
app.get('/api/products/:id', async (req, res) => {
  const store = await new Store().load();
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ ok: false });
  ok(res, { product: p });
});
app.put('/api/products/:id/seo', async (req, res) => {
  try {
    const p = await updateSeo(req.params.id, req.body || {});
    ok(res, { product: p });
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/products/:id/reupload-description', (req, res) => {
  try {
    runJob('description re-upload', () => reuploadDescription(req.params.id));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/products/:id/reupload-specs', (req, res) => {
  try {
    runJob('specs re-upload', () => reuploadSpecs(req.params.id));
    ok(res);
  } catch (e) {
    fail(res, e);
  }
});
app.post('/api/products/:id/reset', async (req, res) => {
  try {
    const p = await resetStage(req.params.id, (req.body && req.body.stage) || 'images');
    ok(res, { product: p });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- live log stream (SSE) ----------
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  send('hello', { job: job.name });
  const onLine = (l) => send('line', l);
  const onJob = (j) => send('job', j);
  logBus.on('line', onLine);
  logBus.on('job', onJob);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    logBus.off('line', onLine);
    logBus.off('job', onJob);
  });
});

app.listen(PORT, () => {
  log.ok(`Web UI running at http://localhost:${PORT}`);
});
