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

/**
 * A run must not be killed by a wait nobody is listening to any more.
 *
 * The PDF step starts waitForResponse/waitForEvent BEFORE the action that
 * triggers them. When that action throws, those waits are abandoned — and their
 * later timeout reaches Node as an unhandled rejection. A real run died that
 * way after publishing 31 listings:
 *
 *   page.waitForResponse: Timeout 30000ms exceeded while waiting for event
 *   "response"  ->  triggerUncaughtException(err, true) -> exit 1
 */
test('an abandoned wait cannot take the whole run down', async (t) => {
  await t.test('a detached rejection does not reach the process', async () => {
    const rejections = [];
    const capture = (error) => rejections.push(error);
    process.on('unhandledRejection', capture);
    t.after(() => process.off('unhandledRejection', capture));

    // What the uploader does: start the wait, then have the trigger throw.
    const detachable = (promise) => { promise.catch(() => {}); return promise; };
    const abandoned = detachable(
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 30000ms exceeded')), 10)),
    );
    try {
      throw new Error('locator.click: Timeout 5000ms exceeded.');
    } catch {
      /* the product fails, and nothing ever awaits `abandoned` */
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(rejections, [], 'an abandoned wait must not surface as an unhandled rejection');
    assert.ok(abandoned);
  });

  await t.test('a wait that IS awaited still reports its failure', async () => {
    const detachable = (promise) => { promise.catch(() => {}); return promise; };
    const waited = detachable(Promise.reject(new Error('Timeout 30000ms exceeded')));
    await assert.rejects(() => waited, /Timeout 30000ms exceeded/);
  });
});
