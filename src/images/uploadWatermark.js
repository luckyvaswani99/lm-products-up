import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getWatermarkLogo, loadWatermarkSettings } from '../watermark/settings.js';

function fileDataUrl(filePath, forcedMime = '') {
  const extension = path.extname(filePath).toLowerCase();
  const mime = forcedMime || (extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg');
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

export function getUploadWatermarkRuntime() {
  const settings = loadWatermarkSettings();
  if (!settings.enabled) return null;
  if (settings.mode === 'text') {
    if (!settings.text) throw new Error('Text watermarking is enabled but watermark text is empty');
    return { settings, logoDataUrl: null };
  }
  const logo = getWatermarkLogo();
  if (!logo) throw new Error('Image watermarking is enabled but no watermark image is selected');
  return { settings, logoDataUrl: fileDataUrl(logo.filePath, logo.mime) };
}

export function shouldWatermarkImage(runtime, imageIndex) {
  if (!runtime) return false;
  return runtime.settings.applyTo === 'all' || imageIndex === 0;
}

/** Apply the saved upload watermark to a temporary copy; the source file is never modified. */
export async function applyUploadWatermark(page, imagePath, productId, runtime) {
  const source = fileDataUrl(path.resolve(imagePath));
  const result = await page.evaluate(
    async ({ sourceUrl, logoUrl, settings }) => {
      const loadImage = (url, description) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error(`Browser could not decode ${description}`));
          image.src = url;
        });

      const sourceImage = await loadImage(sourceUrl, 'the product image');
      const logoImage = settings.mode === 'image' ? await loadImage(logoUrl, 'the watermark image') : null;
      const width = sourceImage.naturalWidth;
      const height = sourceImage.naturalHeight;
      const shortSide = Math.min(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(sourceImage, 0, 0);

      const rotation = (settings.rotation * Math.PI) / 180;
      let markWidth;
      let markHeight;
      let fontSize;
      let padding = 0;

      if (settings.mode === 'text') {
        fontSize = Math.max(10, Math.round(shortSide * settings.textSizePercent / 100));
        context.font = `${settings.fontWeight} ${fontSize}px "${settings.fontFamily}", sans-serif`;
        const maximumWidth = width * 0.82;
        while (fontSize > 10 && context.measureText(settings.text).width > maximumWidth) {
          fontSize -= 1;
          context.font = `${settings.fontWeight} ${fontSize}px "${settings.fontFamily}", sans-serif`;
        }
        padding = Math.round(shortSide * settings.backgroundPaddingPercent / 100);
        markWidth = Math.ceil(context.measureText(settings.text).width) + padding * 2;
        markHeight = Math.ceil(fontSize * 1.25) + padding * 2;
      } else {
        markWidth = Math.round(width * settings.imageWidthPercent / 100);
        markHeight = Math.max(1, Math.round(markWidth * logoImage.naturalHeight / logoImage.naturalWidth));
        if (markHeight > height * 0.8) {
          const scale = height * 0.8 / markHeight;
          markWidth = Math.round(markWidth * scale);
          markHeight = Math.round(markHeight * scale);
        }
      }

      const drawAt = (centerX, centerY) => {
        context.save();
        context.translate(centerX, centerY);
        context.rotate(rotation);
        if (settings.mode === 'text') {
          if (settings.backgroundEnabled) {
            context.globalAlpha = settings.backgroundOpacity / 100;
            context.fillStyle = settings.backgroundColor;
            context.fillRect(-markWidth / 2, -markHeight / 2, markWidth, markHeight);
          }
          context.globalAlpha = settings.opacity / 100;
          context.fillStyle = settings.textColor;
          context.font = `${settings.fontWeight} ${fontSize}px "${settings.fontFamily}", sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(settings.text, 0, 0);
        } else {
          context.globalAlpha = settings.opacity / 100;
          context.drawImage(logoImage, -markWidth / 2, -markHeight / 2, markWidth, markHeight);
        }
        context.restore();
      };

      if (settings.pattern === 'tile') {
        const spacing = Math.round(shortSide * settings.tileSpacingPercent / 100);
        const stepX = Math.max(20, markWidth + spacing);
        const stepY = Math.max(20, markHeight + spacing);
        let row = 0;
        for (let y = -markHeight; y <= height + markHeight; y += stepY) {
          const offset = row % 2 ? stepX / 2 : 0;
          for (let x = -markWidth + offset; x <= width + markWidth; x += stepX) drawAt(x, y);
          row += 1;
        }
      } else {
        const margin = Math.round(shortSide * settings.marginPercent / 100);
        const horizontal = settings.position.split('-').at(-1);
        const vertical = settings.position.split('-')[0];
        // Position by the rotated bounding box so non-zero advanced rotation
        // cannot clip a single watermark against the selected image edge.
        const rotatedWidth = Math.abs(markWidth * Math.cos(rotation)) + Math.abs(markHeight * Math.sin(rotation));
        const rotatedHeight = Math.abs(markWidth * Math.sin(rotation)) + Math.abs(markHeight * Math.cos(rotation));
        const centerX = settings.position === 'center' || horizontal === 'center'
          ? width / 2
          : horizontal === 'left'
            ? margin + rotatedWidth / 2
            : width - margin - rotatedWidth / 2;
        const centerY = settings.position === 'center' || vertical === 'center'
          ? height / 2
          : vertical === 'top'
            ? margin + rotatedHeight / 2
            : height - margin - rotatedHeight / 2;
        drawAt(centerX, centerY);
      }

      return {
        width,
        height,
        base64: canvas.toDataURL('image/jpeg', settings.quality / 100).split(',')[1],
      };
    },
    { sourceUrl: source, logoUrl: runtime.logoDataUrl, settings: runtime.settings },
  );

  const safeId = String(productId || 'product').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 100);
  const outputPath = path.join(config.dataDir, `.upload-${safeId}-watermarked-${Date.now()}.jpg`);
  fs.writeFileSync(outputPath, Buffer.from(result.base64, 'base64'));
  return { filePath: outputPath, temporary: true, watermarked: true, width: result.width, height: result.height };
}
