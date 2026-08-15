/**
 * IndiaMART screens uploaded photos against the ones a listing already has and
 * silently drops the ones it considers duplicates.
 *
 * Recorded live on item 331716490 (Accuret): the CDN upload returned
 * {"Code":200,"Status":"Success"}, the cropper showed 3 of 3 thumbnails, then a
 * POST to uploading.imimg.com/dedup produced this modal — which closes itself
 * after about four seconds and was never seen by the uploader:
 *
 *   Photo rejected during upload!
 *   Below photo was rejected due to the given reasons:
 *   Photo already available in Product
 *   ✖ .upload-...-watermarked-1786796148745.jpg
 *
 * The listing kept 2 photos and the run reported "retained 2/3 source photos"
 * with no reason, so the product failed the same way on every retry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { readPhotoRejections } from '../src/uploader/indiamartUploader.js';

/** The modal exactly as the portal rendered it. */
const DEDUP_MODAL = `
  <div class="modal_dedup SLC_PopCntr pa">
    <button class="close-button" onclick="closeDedupPopup();">×</button>
    <h2>Photo rejected during upload!</h2>
    <p class="dedup-subtitle">Below photo was rejected due to the given reasons:</p>
    <div class="dedup-rejection-section">
      <p class="dedup-rejection-heading"><strong>Photo already available in Product</strong></p>
      <ul><li><span>✖</span><a href="https://5.imimg.com/x.jpg">accuret-photo-3.jpg</a></li></ul>
    </div>
    <button id="ok">OK</button>
  </div>`;

test('IndiaMART’s photo rejection is read and named, not silently lost', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await t.test('reports the portal’s own reason and file name', async () => {
    await page.setContent(DEDUP_MODAL);
    const rejected = await readPhotoRejections(page, 3000);

    assert.deepEqual(rejected, [
      { reason: 'Photo already available in Product', file: 'accuret-photo-3.jpg' },
    ]);
  });

  await t.test('dismisses the modal so it cannot block the next step', async () => {
    // OK has no handler on this fixture, so assert the click was attempted
    // against the real control rather than the modal vanishing by itself.
    await page.setContent(DEDUP_MODAL.replace('<button id="ok">OK</button>',
      '<button id="ok" onclick="document.querySelector(\'.modal_dedup\').remove()">OK</button>'));
    await readPhotoRejections(page, 3000);
    assert.equal(await page.locator('.modal_dedup').count(), 0);
  });

  await t.test('several refused photos are all listed', async () => {
    await page.setContent(`
      <div class="modal_dedup">
        <div class="dedup-rejection-section">
          <p class="dedup-rejection-heading"><strong>Photo already available in Product</strong></p>
          <ul><li><a>one.jpg</a></li><li><a>two.jpg</a></li></ul>
        </div>
      </div>`);
    const rejected = await readPhotoRejections(page, 3000);
    assert.deepEqual(rejected.map((r) => r.file), ['one.jpg', 'two.jpg']);
  });

  await t.test('a clean upload waits briefly and reports nothing', async () => {
    await page.setContent('<div>no modal here</div>');
    const started = Date.now();
    assert.deepEqual(await readPhotoRejections(page, 1000), []);
    assert.ok(Date.now() - started < 5000, 'must not stall when there is nothing to report');
  });
});

/**
 * IndiaMART can navigate the tab away from an open product form.
 *
 * Recorded live: the editor was filled and the PDF retained, then thirteen
 * seconds later Save and Continue was gone because the page had moved to
 * .../manageproducts/?opensuggprodview=redirectsellerrecom. The run reported
 * 'Could not click active Add Product Save and Continue; visible layers:
 * popup-toggle btn_cstmm: Help Videos' — which says nothing about the cause.
 */
test('the portal navigating away is told apart from a blocked button', async (t) => {
  const { portalRedirected, PORTAL_REDIRECT } = await import('../src/uploader/indiamartUploader.js');

  await t.test('recognises the recorded redirect, by url or by error', () => {
    assert.ok(portalRedirected(
      'https://seller.indiamart.com/product/manageproducts/?opensuggprodview=redirectsellerrecom',
    ));
    assert.ok(portalRedirected(new Error(`${PORTAL_REDIRECT}: the product form is gone, page is at …`)));
  });

  await t.test('an ordinary blocked button is not mistaken for it', () => {
    assert.equal(portalRedirected('https://seller.indiamart.com/product/manageproducts/'), false);
    assert.equal(
      portalRedirected(new Error('Could not click active Add Product Save and Continue; visible layers: im-crop-block')),
      false,
    );
  });
});
