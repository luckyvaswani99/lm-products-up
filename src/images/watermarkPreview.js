import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import {
  getUploadImageRuntime,
  prepareUploadImage,
  shouldProcessUploadImage,
} from './uploadImagePreparation.js';
import { productImageFiles } from './productImageFiles.js';

const previewDir = path.join(config.dataDir, 'watermark', 'preview-cache');
let browserPromise = null;
let renderQueue = Promise.resolve();

function safePart(value) {
  return String(value || 'product').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 90);
}

function previewFingerprint(sourcePath, runtime, imageIndex) {
  const stat = fs.statSync(sourcePath);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      backgroundRemoval: runtime.backgroundRemoval?.settings || null,
      watermark: runtime.watermark?.settings || null,
    }))
    .update(runtime.watermark?.logoDataUrl || '')
    .update(path.resolve(sourcePath))
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .update(String(imageIndex))
    .digest('hex')
    .slice(0, 16);
}

async function previewBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

function enqueueRender(work) {
  const next = renderQueue.then(work, work);
  renderQueue = next.catch(() => {});
  return next;
}

export function clearUploadPreviewCache() {
  fs.rmSync(previewDir, { recursive: true, force: true });
}

/**
 * Return a non-destructive preview of the exact upload image at one-based
 * gallery index. Unprocessed images return their persistent source; enabled
 * processing is rendered once into a settings/source-keyed cache.
 */
export async function getUploadPreviewFile(product, requestedIndex = 1) {
  const files = productImageFiles(product);
  const index = Math.max(1, Number(requestedIndex) || 1) - 1;
  const sourcePath = files[index];
  if (!sourcePath) return null;

  const runtime = getUploadImageRuntime();
  if (!shouldProcessUploadImage(runtime, index)) return sourcePath;

  const fingerprint = previewFingerprint(sourcePath, runtime, index);
  const prefix = `${safePart(product.id)}-${index + 1}-`;
  const outputPath = path.join(previewDir, `${prefix}${fingerprint}.jpg`);
  if (fs.existsSync(outputPath)) return outputPath;

  await enqueueRender(async () => {
    if (fs.existsSync(outputPath)) return;
    fs.mkdirSync(previewDir, { recursive: true });
    const browser = await previewBrowser();
    const page = await browser.newPage();
    let temporary = null;
    try {
      temporary = await prepareUploadImage(
        page,
        sourcePath,
        `${safePart(product.id)}-preview-${index + 1}`,
        runtime,
        index,
      );
      if (!temporary.temporary) throw new Error('Upload preview processing returned a persistent source file');
      fs.renameSync(temporary.filePath, outputPath);
      temporary = null;
      for (const file of fs.readdirSync(previewDir)) {
        if (file.startsWith(prefix) && file !== path.basename(outputPath)) {
          fs.rmSync(path.join(previewDir, file), { force: true });
        }
      }
    } finally {
      if (temporary?.temporary && temporary.filePath) fs.rmSync(temporary.filePath, { force: true });
      await page.close().catch(() => {});
    }
  });

  return outputPath;
}
