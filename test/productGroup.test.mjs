/**
 * The product group the user typed has to land on THIS listing.
 *
 * Observed on a run of ten uploads: every product reported
 *   group not set: item … shows group "Pharmaceutical Injections" instead of
 *   "Erectile Dysfunction Medicine"
 * The typed group was never created and every listing kept whatever group
 * IndiaMART had placed it in.
 *
 * Manage Products renders the group menu once per listing, so the chips, the
 * "+ Create New Group" field (a repeated `id="addNewGroupName"`) and its "Done"
 * all exist many times over on the page. A page-wide lookup therefore reaches
 * another card — the same hazard that once renamed an unrelated listing through
 * a page-wide `#nameOfProduct`. These tests pin both halves: the typed name
 * reaches our card, and no other card is touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { Uploader } from '../src/uploader/indiamartUploader.js';

/**
 * Two listings, each with its own complete group menu. The OTHER card comes
 * first in the document and carries the chips the real account has, so a
 * page-wide `#addNewGroupName` / `Done` / chip lookup resolves to it.
 */
const twoCards = (groups) => `
  <div class="MPSD_prdlstcont" id="card-other">
    <a class="MPSD_prdname" id="itemName111111">Some Other Live Product</a>
    <div><span style="display:block">Group</span><span style="display:block">Steroids Tablets</span></div>
    <div class="MPSD_Groupmenu">
      ${groups
        .map(
          (name, index) =>
            `<span class="MPSD_Groupmenutxt" data-catid="${900 + index}" data-catname="${name}">${name}</span>`,
        )
        .join('')}
      <span class="create">+ Create New Group</span>
      <input id="addNewGroupName">
      <span class="done">Done</span>
    </div>
  </div>
  <div class="MPSD_prdlstcont" id="card-ours">
    <a class="MPSD_prdname" id="itemName333992728">Poxijuv 60mg Tablet</a>
    <div><span style="display:block">Group</span><span style="display:block" id="ourGroup">Erectyle Dysfunction Medicines</span></div>
    <div class="MPSD_Groupmenu">
      ${groups
        .map(
          (name, index) =>
            `<span class="MPSD_Groupmenutxt" data-catid="${100 + index}" data-catname="${name}">${name}</span>`,
        )
        .join('')}
      <span class="create">+ Create New Group</span>
      <input id="addNewGroupName">
      <span class="done">Done</span>
    </div>
  </div>
  <script>
    // Each menu only ever answers for the card it belongs to, exactly like the
    // portal's own per-card handlers.
    for (const card of document.querySelectorAll('.MPSD_prdlstcont')) {
      const label = card.querySelector('div > span:last-child');
      const field = card.querySelector('#addNewGroupName');
      const apply = (name) => {
        label.textContent = name;
        window.touched = (window.touched || []).concat(card.id + ':' + name);
      };
      card.querySelectorAll('.MPSD_Groupmenutxt').forEach((chip) => {
        chip.onclick = () => apply(chip.getAttribute('data-catname'));
      });
      card.querySelector('.done').onclick = () => apply(field.value);
    }
  </script>`;

/** An uploader whose read-back resolves to the card we name, nothing live. */
const uploaderOn = (page, cardSelector, itemId) => {
  const uploader = new Uploader();
  uploader.page = page;
  uploader.gotoManage = async () => {};
  uploader._findActiveProduct = async () => ({ itemId, card: page.locator(cardSelector) });
  return uploader;
};

const product = { id: 'poxijuv', name: 'Poxijuv 60mg Tablet' };

test('a group the account does not have is created on this listing', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(twoCards(['Steroids Tablets', 'Pharmaceutical Injections', 'Erectyle Dysfunction Medicines']));
  const uploader = uploaderOn(page, '#card-ours', '333992728');
  const live = { itemId: '333992728', card: page.locator('#card-ours') };

  const result = await uploader.setProductGroup(product, live, 'Erectile Dysfunction Medicine');

  assert.equal(result.group, 'Erectile Dysfunction Medicine');
  assert.equal(result.created, true, 'the typed group did not exist, so it is created');
  assert.deepEqual(
    await page.evaluate(() => window.touched),
    ['card-ours:Erectile Dysfunction Medicine'],
    'only this listing was changed',
  );
});

test('a group the account already has is reused, not duplicated', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(twoCards(['Steroids Tablets', 'Erectile Dysfunction Medicine']));
  const uploader = uploaderOn(page, '#card-ours', '333992728');
  const live = { itemId: '333992728', card: page.locator('#card-ours') };

  // Typed in a different case, which is how a second run arrives.
  const result = await uploader.setProductGroup(product, live, 'erectile dysfunction MEDICINE');

  assert.equal(result.created, false, 'the account already has it');
  assert.deepEqual(await page.evaluate(() => window.touched), ['card-ours:Erectile Dysfunction Medicine']);
});

test('a listing already in the group is left alone', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(twoCards(['Erectile Dysfunction Medicine']));
  await page.evaluate(() => {
    document.getElementById('ourGroup').textContent = 'Erectile Dysfunction Medicine';
  });
  const uploader = uploaderOn(page, '#card-ours', '333992728');
  const live = { itemId: '333992728', card: page.locator('#card-ours') };

  const result = await uploader.setProductGroup(product, live, 'Erectile Dysfunction Medicine');

  assert.equal(result.changed, false);
  assert.equal(await page.evaluate(() => window.touched ?? null), null, 'nothing was clicked at all');
});

test('no group typed means no listing is touched', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(twoCards(['Steroids Tablets']));
  const uploader = uploaderOn(page, '#card-ours', '333992728');
  const live = { itemId: '333992728', card: page.locator('#card-ours') };

  assert.deepEqual(await uploader.setProductGroup(product, live, '  '), { group: '', changed: false });
  assert.equal(await page.evaluate(() => window.touched ?? null), null);
});
