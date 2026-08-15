import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { log } from '../logger.js';
import { loadWatermarkSettings } from '../watermark/settings.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MIN_IMAGE_SIDE = 500;

function extFromUrl(url, contentType = '') {
  const clean = url.split('?')[0];
  const m = clean.match(/\.(png|jpe?g|webp|gif)$/i);
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  if (/png/.test(contentType)) return '.png';
  if (/webp/.test(contentType)) return '.webp';
  return '.jpg';
}

/** Read dimensions without decoding the common IndiaMART PNG/JPEG formats. */
function imageDimensions(buffer) {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer.toString('ascii', 1, 4) === 'PNG'
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (startOfFrame.has(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return null;
}

async function padToMinimum(page, buffer, mime) {
  const source = `data:${mime};base64,${buffer.toString('base64')}`;
  return page.evaluate(
    async ({ dataUrl, minSide }) => {
      const image = await new Promise((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = () => reject(new Error('Browser could not decode downloaded image'));
        candidate.src = dataUrl;
      });
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (width >= minSide && height >= minSide) return { width, height, base64: null };

      const outputWidth = Math.max(width, minSide);
      const outputHeight = Math.max(height, minSide);
      const scale = Math.min(outputWidth / width, outputHeight / height);
      const drawWidth = Math.round(width * scale);
      const drawHeight = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, outputWidth, outputHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        image,
        Math.round((outputWidth - drawWidth) / 2),
        Math.round((outputHeight - drawHeight) / 2),
        drawWidth,
        drawHeight,
      );
      return {
        width,
        height,
        outputWidth,
        outputHeight,
        base64: canvas.toDataURL('image/jpeg', 0.92).split(',')[1],
      };
    },
    { dataUrl: source, minSide: MIN_IMAGE_SIDE },
  );
}

function sellerIdFromImageUrl(url) {
  return (String(url || '').match(/\/data5\/SELLER\/Default\/[^?#]+\/(\d+)\/[^/]+$/i) || [])[1] || '';
}

function authorizedWatermarkSeller(url) {
  if (!config.image.watermark.replaceAuthorizedSource) return '';
  const sellerId = sellerIdFromImageUrl(url);
  return config.image.watermark.authorizedSellerIds.includes(sellerId) ? sellerId : '';
}

/**
 * Replace the authorized Kyvex-style mark in the isolated top-left white area,
 * then add our configured text mark at bottom-right. This is deterministic
 * Canvas processing; no AI provider is involved.
 */
export async function replaceAuthorizedWatermark(page, buffer, mime, text) {
  const source = `data:${mime};base64,${buffer.toString('base64')}`;
  return page.evaluate(
    async ({ dataUrl, watermarkText }) => {
      const image = await new Promise((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = () => reject(new Error('Browser could not decode authorized source image'));
        candidate.src = dataUrl;
      });
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);

      // This seller's current watermark was measured on all six live source
      // images for the two affected products. Its repeated artwork/text stays
      // inside x=31..210 and y=15..205 at 1000x1000. Use a fixed normalized
      // patch around only that verified footprint; never expand it from all
      // non-white pixels because those pixels can belong to the product.
      const clearX = Math.round(width * 0.018);
      const clearY = Math.round(height * 0.01);
      const clearRight = Math.round(width * 0.212);
      const clearBottom = Math.round(height * 0.220);
      const clearWidth = clearRight - clearX;
      const clearHeight = clearBottom - clearY;
      const pixels = context.getImageData(clearX, clearY, clearWidth, clearHeight).data;
      let inkPixels = 0;
      let logoInk = 0;
      let middleTextInk = 0;
      let lowerTextInk = 0;
      let boundaryInk = 0;
      const boundaryMargin = Math.max(6, Math.round(Math.min(width, height) * 0.008));
      for (let y = 0; y < clearHeight; y += 1) {
        for (let x = 0; x < clearWidth; x += 1) {
          const offset = (y * clearWidth + x) * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          const alpha = pixels[offset + 3];
          if (alpha <= 40 || (red >= 238 && green >= 238 && blue >= 238)) continue;
          inkPixels += 1;
          const sourceY = clearY + y;
          if (sourceY < height * 0.14) logoInk += 1;
          else if (sourceY < height * 0.18) middleTextInk += 1;
          else lowerTextInk += 1;
          // The verified watermark has clear white margins at the patch's
          // right and bottom edges. Real package artwork that enters this
          // top-left patch continues beyond one of those edges. Checking this
          // continuation distinguishes a larger legitimate logo (10,441 ink
          // pixels in Accurate frame 2) from overlapping product artwork.
          if (x >= clearWidth - boundaryMargin || y >= clearHeight - boundaryMargin) {
            boundaryInk += 1;
          }
        }
      }
      const fingerprintPresent =
        logoInk > 2000 &&
        middleTextInk > 700 &&
        lowerTextInk > 350;
      if (!fingerprintPresent) {
        // The mark is not confidently identified, so the patch must NOT be
        // whitened — clearing it could erase product pixels. Keeping the
        // source image is the safe outcome, not a download failure: this
        // seller renders the same logo at different sizes (a 1000x1000 frame
        // measured 21..169 tall against 25..207 on an earlier product), which
        // shifts the ink out of these fixed bands. Background removal at
        // upload time still strips the corner mark.
        return {
          width,
          height,
          skipped: true,
          skipReason:
            `top-left mark did not match the verified fingerprint ` +
            `(bands ${logoInk}/${middleTextInk}/${lowerTextInk})`,
          detection: { inkPixels, logoInk, middleTextInk, lowerTextInk, boundaryInk },
        };
      }

      // Preserve the source byte-for-byte when non-white artwork continues
      // through the safe patch boundary. Removing an overlapping watermark
      // cannot reconstruct the product pixels hidden behind it.
      if (boundaryInk > 100) {
        return {
          width,
          height,
          skipped: true,
          skipReason: 'product content overlaps the authorized watermark area',
          detection: { inkPixels, logoInk, middleTextInk, lowerTextInk, boundaryInk },
        };
      }

      context.fillStyle = '#ffffff';
      context.fillRect(clearX, clearY, clearWidth, clearHeight);

      const label = String(watermarkText || '').trim();
      let labelBounds = null;
      if (label) {
        // Put our label inside the already-cleared patch. This guarantees the
        // replacement never covers product pixels elsewhere in the image.
        const shortSide = Math.min(width, height);
        const paddingX = Math.max(7, Math.round(shortSide * 0.008));
        const paddingY = Math.max(5, Math.round(shortSide * 0.006));
        let fontSize = Math.max(13, Math.round(shortSide * 0.019));
        context.textBaseline = 'middle';
        context.textAlign = 'left';
        context.font = `600 ${fontSize}px Arial, sans-serif`;
        const maxTextWidth = clearWidth - paddingX * 2;
        while (fontSize > 12 && context.measureText(label).width > maxTextWidth) {
          fontSize -= 1;
          context.font = `600 ${fontSize}px Arial, sans-serif`;
        }
        const textWidth = Math.min(maxTextWidth, Math.ceil(context.measureText(label).width));
        const boxWidth = textWidth + paddingX * 2;
        const boxHeight = fontSize + paddingY * 2;
        const x = clearX + Math.round((clearWidth - boxWidth) / 2);
        const y = clearY + Math.round((clearHeight - boxHeight) / 2);
        context.fillStyle = '#ffffff';
        context.fillRect(x, y, boxWidth, boxHeight);
        context.strokeStyle = 'rgba(11, 42, 74, 0.24)';
        context.lineWidth = Math.max(1, Math.round(shortSide * 0.0015));
        context.strokeRect(x, y, boxWidth, boxHeight);
        context.fillStyle = 'rgba(11, 42, 74, 0.82)';
        context.fillText(label, x + paddingX, y + boxHeight / 2);
        labelBounds = { x, y, width: boxWidth, height: boxHeight };
      }

      return {
        width,
        height,
        removedBounds: { x: clearX, y: clearY, width: clearWidth, height: clearHeight },
        labelBounds,
        detection: { inkPixels, logoInk, middleTextInk, lowerTextInk },
        textApplied: Boolean(label),
        base64: canvas.toDataURL('image/jpeg', 0.94).split(',')[1],
      };
    },
    { dataUrl: source, watermarkText: text },
  );
}

/** Download every imageUrl for a product into data/images. Returns local file paths. */
export async function downloadImages(product) {
  await fsp.mkdir(config.imagesDir, { recursive: true });
  const paths = [];
  // The general upload watermark is applied later to temporary upload copies.
  // When it is enabled, keep this authorized cleanup patch blank so the old
  // legacy text mark cannot be baked underneath the selected text/logo mark.
  const uploadWatermarkEnabled = loadWatermarkSettings().enabled;
  const authorizedReplacementText = uploadWatermarkEnabled ? '' : config.image.watermark.text;
  let browser;
  let imagePage;
  let i = 0;
  const getImagePage = async () => {
    if (!imagePage) {
      browser = await chromium.launch({ headless: true });
      imagePage = await browser.newPage();
    }
    return imagePage;
  };

  try {
    for (const url of product.imageUrls || []) {
      if (!/^https?:/.test(url)) continue;
      i += 1;
      const dest = path.join(config.imagesDir, `${product.id}-${i}`);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.indiamart.com/' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 800) throw new Error('too small');

        const contentType = res.headers.get('content-type') || '';
        let extension = extFromUrl(url, contentType);
        let mime = /png/i.test(contentType) || extension === '.png'
          ? 'image/png'
          : /webp/i.test(contentType) || extension === '.webp'
            ? 'image/webp'
            : /gif/i.test(contentType) || extension === '.gif'
              ? 'image/gif'
              : 'image/jpeg';
        const dimensions = imageDimensions(buffer);
        if (!dimensions || dimensions.width < MIN_IMAGE_SIDE || dimensions.height < MIN_IMAGE_SIDE) {
          const prepared = await padToMinimum(await getImagePage(), buffer, mime);
          if (prepared.base64) {
            buffer = Buffer.from(prepared.base64, 'base64');
            extension = '.jpg';
            mime = 'image/jpeg';
            log.info(
              `  prepared downloaded image ${prepared.width}x${prepared.height} -> ` +
                `${prepared.outputWidth}x${prepared.outputHeight}`,
            );
          }
        }

        const authorizedSellerId = authorizedWatermarkSeller(url);
        if (authorizedSellerId) {
          const transformed = await replaceAuthorizedWatermark(
            await getImagePage(),
            buffer,
            mime,
            authorizedReplacementText,
          );
          if (transformed.skipped) {
            log.warn(
              `  preserved authorized source image unchanged (seller ${authorizedSellerId}): ` +
                `${transformed.skipReason}; fingerprint ink ${transformed.detection.inkPixels}`,
            );
          } else {
            buffer = Buffer.from(transformed.base64, 'base64');
            extension = '.jpg';
            mime = 'image/jpeg';
            log.info(
              `  replaced authorized source watermark (seller ${authorizedSellerId}) in ` +
                `${transformed.removedBounds.width}x${transformed.removedBounds.height} safe patch` +
                (transformed.textApplied
                  ? ` and added "${authorizedReplacementText}" at ${transformed.width}x${transformed.height}`
                  : ' without a legacy text mark because the general upload watermark is enabled'),
            );
          }
        }

        const finalDimensions = imageDimensions(buffer);
        if (!finalDimensions || finalDimensions.width < MIN_IMAGE_SIDE || finalDimensions.height < MIN_IMAGE_SIDE) {
          throw new Error('could not prepare image to minimum 500x500 dimensions');
        }
        const file = dest + extension;
        await fsp.writeFile(file, buffer);
        paths.push(file);
      } catch (e) {
        log.warn(`  image download failed (${url.slice(0, 60)}): ${e.message}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return paths;
}

export function readAsDataUri(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).replace('jpg', 'jpeg') || 'png';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}
