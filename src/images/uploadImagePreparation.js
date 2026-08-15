import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import {
  applyBackgroundRemoval,
  getBackgroundRemovalRuntime,
  shouldRemoveBackground,
} from '../backgroundRemoval/processor.js';
import {
  applyUploadWatermark,
  getUploadWatermarkRuntime,
  shouldWatermarkImage,
} from './uploadWatermark.js';

const MIN_IMAGE_SIDE = 500;

export function getUploadImageRuntime() {
  return {
    backgroundRemoval: getBackgroundRemovalRuntime(),
    watermark: getUploadWatermarkRuntime(),
  };
}

export function shouldProcessUploadImage(runtime, imageIndex) {
  return (
    shouldRemoveBackground(runtime.backgroundRemoval, imageIndex) ||
    shouldWatermarkImage(runtime.watermark, imageIndex)
  );
}

/**
 * IndiaMART rejects an image when either side is below 500 px. Temporary
 * background-removed PNGs are also flattened onto white before upload unless
 * the watermark renderer will perform that flattening in the next stage.
 */
async function prepareImageForUpload(page, imagePath, productId, forceJpeg = false, isTemporary = false) {
  const resolved = path.resolve(imagePath);
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
  const prepared = await page.evaluate(
    async ({ source, minSide, convertToJpeg }) => {
      const image = await new Promise((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = () => reject(new Error('Browser could not decode the image'));
        candidate.src = source;
      });
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (width >= minSide && height >= minSide && !convertToJpeg) return { width, height, base64: null };

      const targetWidth = Math.max(width, minSide);
      const targetHeight = Math.max(height, minSide);
      const scale = Math.min(targetWidth / width, targetHeight / height);
      const drawWidth = Math.round(width * scale);
      const drawHeight = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        image,
        Math.round((targetWidth - drawWidth) / 2),
        Math.round((targetHeight - drawHeight) / 2),
        drawWidth,
        drawHeight,
      );
      return {
        width,
        height,
        outputWidth: targetWidth,
        outputHeight: targetHeight,
        base64: canvas.toDataURL('image/jpeg', 0.92).split(',')[1],
      };
    },
    { source: dataUrl, minSide: MIN_IMAGE_SIDE, convertToJpeg: forceJpeg },
  );

  if (!prepared.base64) return { filePath: resolved, temporary: Boolean(isTemporary), ...prepared };
  const safeId = String(productId || 'product').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80);
  const outputPath = path.join(config.dataDir, `.upload-${safeId}-${Date.now()}.jpg`);
  fs.writeFileSync(outputPath, Buffer.from(prepared.base64, 'base64'));
  if (prepared.width < MIN_IMAGE_SIDE || prepared.height < MIN_IMAGE_SIDE) {
    log.info(
      `  prepared image ${prepared.width}x${prepared.height} -> ` +
        `${prepared.outputWidth}x${prepared.outputHeight} for IndiaMART`,
    );
  }
  return { filePath: outputPath, temporary: true, ...prepared };
}

function removeTemporary(item) {
  if (item?.temporary && item.filePath) fs.rmSync(item.filePath, { force: true });
}

/**
 * Build the exact temporary file sent to IndiaMART. Processing order is local
 * background removal, IndiaMART dimension/white-background normalization, then
 * the optional upload watermark. Persistent source and AI files are untouched.
 */
export async function prepareUploadImage(page, imagePath, productId, runtime, imageIndex) {
  let current = { filePath: path.resolve(imagePath), temporary: false };
  const removeBackground = shouldRemoveBackground(runtime.backgroundRemoval, imageIndex);
  const addWatermark = shouldWatermarkImage(runtime.watermark, imageIndex);

  try {
    if (removeBackground) {
      current = await applyBackgroundRemoval(current.filePath, productId, runtime.backgroundRemoval);
      log.info(`  u2netp CPU background removal prepared on temporary photo ${imageIndex + 1}`);
    }

    const isTempBeforeNormalize = current.temporary === true;
    const isBgRemovedBeforeNormalize = current.backgroundRemoved === true;

    const normalized = await prepareImageForUpload(
      page,
      current.filePath,
      productId,
      removeBackground && !addWatermark,
      isTempBeforeNormalize,
    );

    const isSameFile =
      path.resolve(current.filePath).toLowerCase() === path.resolve(normalized.filePath).toLowerCase();

    if (isTempBeforeNormalize) {
      if (isSameFile) {
        normalized.temporary = true;
        if (isBgRemovedBeforeNormalize) normalized.backgroundRemoved = true;
      } else {
        removeTemporary(current);
      }
    }
    current = normalized;

    if (addWatermark) {
      const watermarked = await applyUploadWatermark(page, current.filePath, productId, runtime.watermark);
      removeTemporary(current);
      current = watermarked;
      log.info(
        `  ${runtime.watermark.settings.mode} watermark prepared on temporary photo ${imageIndex + 1} ` +
          `(${runtime.watermark.settings.opacity}% opacity)`,
      );
    }

    return current;
  } catch (error) {
    removeTemporary(current);
    throw error;
  }
}
