/**
 * Regression tests for the fault that failed every multi-photo upload:
 *
 *   upload ✗ …: Gallery upload failed (3 photos): IndiaMART crop preview did
 *   not confirm all 3 selected files: … Change Photo 11 More
 *   Loading images. Please wait …
 *
 * Recorded from the live Add Product form with three real photos: the crop
 * popup renders one `.Thumb_crop` per file it has finished reading plus one
 * trailing `.Thumb_crop.Thumb_Noimage` slot, and keeps "Loading images. Please
 * wait" on screen until the last file is in. Thumbnails appeared at ~2.0s,
 * ~4.5s and ~7.5s, and the "N More" free-slot label lagged with them
 * (12 → 11 → 10). The old code read that label after a fixed 2.5s delay, so it
 * saw a partly-loaded gallery and rejected a selection that was perfectly fine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { waitForCropSelection } from '../src/uploader/indiamartUploader.js';

/**
 * Render the cropper as observed on the portal and let the photos trickle in
 * over `delays` ms, exactly as IndiaMART's reader does. The arrivals are
 * scheduled through `evaluate` because Playwright re-runs inline `<script>`
 * tags only on a page's first `setContent`.
 */
async function cropper(page, delays, { capacity = 13, existing = 0 } = {}) {
  await page.setContent(`
    <div id="im-crop-block" class="is-visible-imcrp">
      <div class="Crop_Thumb_C">
        <div class="SLC_dflx ui-sortable" id="thumbs">
          ${Array.from(
            { length: existing },
            (_, i) => `<div class="Thumb_crop SLC_imgc SLC_bg SLC_cp SLC_pr${i ? '' : ' primary'}"></div>`,
          ).join('')}
          <div class="Thumb_crop  SLC_cp Thumb_Noimage SLC_tac">+</div>
        </div>
        <div id="loading">Loading images. Please wait</div>
        <div id="free">${capacity - existing} More</div>
        <div class="Crop_gCTA">Upload Photos</div>
      </div>
    </div>`);

  await page.evaluate(
    ({ delays: schedule, capacity: total, existing: already }) => {
      const slot = document.querySelector('.Thumb_Noimage');
      let loaded = already;
      schedule.forEach((ms) =>
        setTimeout(() => {
          const thumb = document.createElement('div');
          thumb.className = `Thumb_crop SLC_imgc SLC_bg SLC_cp SLC_pr${loaded ? '' : ' primary'}`;
          slot.parentNode.insertBefore(thumb, slot);
          loaded += 1;
          document.getElementById('free').textContent = `${total - loaded} More`;
          if (loaded === already + schedule.length) document.getElementById('loading').remove();
        }, ms),
      );
    },
    { delays, capacity, existing },
  );
}

test('the crop popup is confirmed only once every selected photo is in', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());
  const crop = page.locator('#im-crop-block.is-visible-imcrp');

  await t.test('waits out the real ~7.5s three-photo load instead of failing at 2.5s', async () => {
    await cropper(page, [300, 1200, 2600]);
    // A fixed 2.5s read would have seen two thumbnails and "11 More" here.
    assert.equal(await waitForCropSelection(page, crop, 3), 3);
    assert.equal(await page.locator('#loading').count(), 0);
  });

  await t.test('a single photo is verified too, not waved through', async () => {
    await cropper(page, [800]);
    assert.equal(await waitForCropSelection(page, crop, 1), 1);
  });

  await t.test('existing gallery photos are counted as a baseline, not as new ones', async () => {
    // Adding the missing tail to a listing that already shows two photos.
    await cropper(page, [400, 900], { existing: 2 });
    assert.equal(await waitForCropSelection(page, crop, 4, 2), 4);
  });

  await t.test('a file the portal rejects is reported with the portal’s own words', async () => {
    await page.setContent(`
      <div id="im-crop-block" class="is-visible-imcrp">
        <div class="Thumb_crop  SLC_cp Thumb_Noimage SLC_tac">+</div>
        <div class="IMerrorMsg">2 photos could not be added</div>
        <div>Image is less than 500 x 500 px</div>
      </div>`);
    await assert.rejects(
      () => waitForCropSelection(page, crop, 3),
      /could not be added|less than 500 x 500/i,
    );
  });

  await t.test('a photo that never arrives is reported by count, never assumed in', async () => {
    await cropper(page, [200]);
    await assert.rejects(
      () => waitForCropSelection(page, crop, 3, 2),
      /read only 1 of 3 photos/i,
    );
  });
});

/**
 * The crop/review popup reopens by itself after the rendered PDF page is
 * confirmed, and its overlay swallows clicks underneath. On one machine it came
 * back *after* Save and Continue (already handled); on another it came back
 * *before*, and every product died with:
 *
 *   Could not click active Add Product Save and Continue; visible layers:
 *   … im-crop-block: … Change Photo 12 More First Photo Upload Photos …
 */
test('a reopening image review popup is drained, not walked into', async (t) => {
  const { Uploader } = await import('../src/uploader/indiamartUploader.js');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());
  const drain = (stage) => Uploader.prototype._drainImageReview.call({ page }, stage);

  /** `reopens` = how many times the popup comes back after being confirmed. */
  const review = (reopens) =>
    page.setContent(`
      <div id="im-crop-block" class="is-visible-imcrp">
        <div>Change Photo</div><div>12 More</div><div id="up">Upload Photos</div>
      </div>
      <script>
        let left = ${reopens};
        document.getElementById('up').addEventListener('click', () => {
          const block = document.getElementById('im-crop-block');
          block.classList.remove('is-visible-imcrp');
          if (left-- > 0) setTimeout(() => block.classList.add('is-visible-imcrp'), 100);
        });
      </script>`);

  await t.test('closes a popup that is already up', async () => {
    await review(0);
    await drain('before Save and Continue');
    assert.equal(await page.locator('#im-crop-block.is-visible-imcrp').count(), 0);
  });

  await t.test('does nothing when no popup is open', async () => {
    await page.setContent('<div id="im-crop-block">hidden</div>');
    await drain('before Save and Continue');
  });

  await t.test('a popup that will not stay closed is reported, not ignored', async () => {
    // A fresh page, because inline scripts only run on a page's first setContent.
    const stubborn = await browser.newPage();
    await stubborn.setContent(`
      <div id="im-crop-block" class="is-visible-imcrp"><div id="up">Upload Photos</div></div>
      <script>
        document.getElementById('up').addEventListener('click', () => {
          const block = document.getElementById('im-crop-block');
          block.classList.remove('is-visible-imcrp');
          setTimeout(() => block.classList.add('is-visible-imcrp'), 100);
        });
      </script>`);
    await assert.rejects(
      () => Uploader.prototype._drainImageReview.call({ page: stubborn }, 'before specifications'),
      /kept reopening before specifications/,
    );
    await stubborn.close();
  });
});
