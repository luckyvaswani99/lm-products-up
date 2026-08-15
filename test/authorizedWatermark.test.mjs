/**
 * The authorized top-left watermark check must never fail a download.
 *
 * The seller renders the same Kyvex mark at different sizes: on a 1000x1000
 * blood-pressure frame its ink spans y 21..169, against y 25..207 on an earlier
 * product. The fixed y-bands only recognise the taller rendering, so every
 * blood-pressure image threw and whole products ended as "no images
 * downloaded". An unrecognised mark now preserves the source instead — the
 * patch is never whitened on a guess, and background removal at upload time
 * still strips the corner mark.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { replaceAuthorizedWatermark } from '../src/images/downloader.js';

/** A 1000x1000 white frame with `blocks` of black drawn in the top-left. */
async function frame(page, blocks) {
  const base64 = await page.evaluate((rects) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1000;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1000, 1000);
    context.fillStyle = '#000000';
    rects.forEach(([x, y, w, h]) => context.fillRect(x, y, w, h));
    return canvas.toDataURL('image/png').split(',')[1];
  }, blocks);
  return Buffer.from(base64, 'base64');
}

test('an unrecognised top-left mark preserves the image', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  t.after(() => browser.close());

  await t.test('the compact mark is kept, not rejected', async () => {
    // Ink confined to y<180, exactly the shape that used to throw.
    const buffer = await frame(page, [[30, 20, 140, 150]]);
    const result = await replaceAuthorizedWatermark(page, buffer, 'image/png', 'Om Shanti Medical');

    assert.equal(result.skipped, true);
    assert.match(result.skipReason, /did not match the verified fingerprint/);
    assert.equal(result.detection.lowerTextInk, 0);
  });

  await t.test('a blank corner is kept too', async () => {
    const buffer = await frame(page, []);
    const result = await replaceAuthorizedWatermark(page, buffer, 'image/png', 'Om Shanti Medical');

    assert.equal(result.skipped, true);
    assert.equal(result.detection.inkPixels, 0);
  });

  await t.test('never throws, whatever the corner holds', async () => {
    for (const blocks of [[], [[30, 20, 140, 150]], [[18, 10, 194, 210]]]) {
      const buffer = await frame(page, blocks);
      await assert.doesNotReject(() =>
        replaceAuthorizedWatermark(page, buffer, 'image/png', 'Om Shanti Medical'),
      );
    }
  });

  await t.test('a mark that fills the patch is preserved, not whitened', async () => {
    // Ink reaching the patch edges means product artwork continues through it.
    const buffer = await frame(page, [[18, 10, 194, 210]]);
    const result = await replaceAuthorizedWatermark(page, buffer, 'image/png', 'Om Shanti Medical');

    assert.equal(result.skipped, true);
    assert.equal(result.base64, undefined);
  });
});
