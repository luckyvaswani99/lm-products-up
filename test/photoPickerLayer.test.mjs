/**
 * The photo picker's shell must not outlive the photo step.
 *
 * `#photodocpopup` is the layer that opens the file picker. The crop popup
 * inside it is what actually attaches the gallery, and that closes itself — but
 * the shell does not always go with it, and it covers the whole page. The next
 * click of the SAME product then fails:
 *
 *   Could not click active Add Product Save and Continue;
 *   visible layers: photodocpopup: ×
 *
 * Six products were lost to this in one three-lane run, making it the single
 * biggest cause of failure. These tests reproduce the covered button.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { Uploader, clickThrough, dismissPhotoPicker } from '../src/uploader/indiamartUploader.js';

/**
 * Save and Continue with the picker shell laid over it, as the real page has
 * it: a fixed full-page layer at a higher z-index, so a real click lands on
 * the layer and never on the button.
 */
const pageWithPickerOver = (closer) => `
  <div id="editProductPopup">
    <div class="MPSD_AdEditSVCon" style="position:relative;z-index:1">Save and Continue</div>
  </div>
  <div id="photodocpopup"
       style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4)">
    ${closer}
  </div>
  <script>
    window.saved = false;
    document.querySelector('.MPSD_AdEditSVCon').onclick = () => { window.saved = true; };
    const picker = document.getElementById('photodocpopup');
    for (const el of picker.querySelectorAll('[data-close]')) {
      el.onclick = () => picker.remove();
    }
  </script>`;

const uploaderOn = (page) => {
  const uploader = new Uploader();
  uploader.page = page;
  // The crop popup is a separate concern and is absent in these pages.
  return uploader;
};

test('Save and Continue still gets clicked through a leftover picker layer', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  // No closer at all: the layer cannot be dismissed, which is the worst case
  // and the one the product used to be lost on.
  await page.setContent(pageWithPickerOver(''));
  const saveContinue = page
    .locator('#editProductPopup .MPSD_AdEditSVCon')
    .filter({ hasText: 'Save and Continue' })
    .first();

  // The layer survives, so dismissal alone cannot save this product.
  assert.equal(await dismissPhotoPicker(page), false);

  // A plain click — what used to be here — cannot land.
  await assert.rejects(
    () => saveContinue.click({ timeout: 1200 }),
    /intercepts pointer events|Timeout/,
    'a plain click really is blocked by the layer',
  );
  assert.equal(await page.evaluate(() => window.saved), false);

  // clickThrough reaches the button's own handler instead of waiting out the
  // timeout and failing the product.
  await clickThrough(saveContinue, 1500);
  assert.equal(await page.evaluate(() => window.saved), true, 'the save went through');
});

test('a picker with a close control is dismissed before the next click', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(pageWithPickerOver('<span class="closebtn" data-close>×</span>'));
  const uploader = uploaderOn(page);

  await uploader._drainImageReview('before Save and Continue');

  assert.equal(
    await page.evaluate(() => !!document.getElementById('photodocpopup')),
    false,
    'the layer is gone, so the button underneath is clickable',
  );
  await page.locator('.MPSD_AdEditSVCon').click({ timeout: 2000 });
  assert.equal(await page.evaluate(() => window.saved), true);
});

test('a picker offering only Cancel is also dismissed', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(pageWithPickerOver('<span data-close>Cancel</span>'));
  await uploaderOn(page)._drainImageReview('before Save and Continue');

  assert.equal(await page.evaluate(() => !!document.getElementById('photodocpopup')), false);
});

test('no picker layer is not treated as a problem', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(`
    <div id="editProductPopup">
      <div class="MPSD_AdEditSVCon">Save and Continue</div>
    </div>`);
  await assert.doesNotReject(() => uploaderOn(page)._drainImageReview('before Save and Continue'));
});
