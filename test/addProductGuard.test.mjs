/**
 * Guards for the fault that renamed an unrelated live listing and then
 * reported the upload as successful.
 *
 * Root cause: form fields were resolved page-wide —
 *   page.locator('#nameOfProduct, input[placeholder=…]').first()
 * Manage Products renders inputs for every listing, so `.first()` could resolve
 * to another product's field. The "is the form blank?" check read that same
 * wrong element, saw an empty value, allowed the run to continue, and the next
 * step typed this product's name over that listing.
 *
 * Fields are now scoped to the open #editProductPopup, and every run proves it
 * left all other listings' names untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { Uploader, collateralRenames } from '../src/uploader/indiamartUploader.js';
import { config } from '../src/config.js';

/**
 * Another listing's inline field deliberately appears BEFORE the popup in DOM
 * order and shares the id, reproducing what made `.first()` pick the wrong one.
 */
const pageWithForeignField = (popupName) => `
  <input id="nameOfProduct" value="Some Other Live Product">
  <button type="button" id="add">Add Product</button>
  <div id="editProductPopup" style="display:none">
    <input id="nameOfProduct" value="${popupName}">
    <div contenteditable="true"></div>
  </div>
  <script>
    document.getElementById('add').onclick = () => {
      document.getElementById('editProductPopup').style.display = 'block';
    };
  </script>`;

const foreignValue = (page) =>
  page.$eval('#editProductPopup', (popup) =>
    [...document.querySelectorAll('#nameOfProduct')].find((input) => !popup.contains(input)).value,
  );

test('form fields never resolve to another listing', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const uploader = new Uploader();
  uploader.page = page;
  t.after(() => browser.close());

  await t.test('a blank popup is accepted while a foreign field holds a name', async () => {
    await page.setContent(pageWithForeignField(''));
    await assert.doesNotReject(() => uploader._openForm());
  });

  await t.test('typing lands in the popup, not the other listing', async () => {
    await page.setContent(pageWithForeignField(''));
    await uploader._openForm();
    await uploader._fillBasics({ name: 'Test E Injection', description: 'Real scraped copy.' });

    assert.equal(await page.inputValue('#editProductPopup #nameOfProduct'), 'Test E Injection');
    // The decisive assertion: the unrelated listing must be untouched.
    assert.equal(await foreignValue(page), 'Some Other Live Product');
  });

  await t.test('refuses when the popup itself already holds a product', async () => {
    const shot = path.join(config.dataDir, 'add-product-opened-existing.png');
    fs.rmSync(shot, { force: true });
    await page.setContent(pageWithForeignField('Already Being Edited'));

    await assert.rejects(
      () => uploader._openForm(),
      /opened the existing listing "Already Being Edited".*nothing was changed/s,
    );
    assert.equal(await page.inputValue('#editProductPopup #nameOfProduct'), 'Already Being Edited');
    fs.rmSync(shot, { force: true });
  });
});

test('a run proves it renamed nothing else', async (t) => {
  await t.test('reports every collateral rename with its item id', () => {
    const before = new Map([
      ['331627101', 'Testoboon Depot Injection'],
      ['998877665', 'Some Other Live Product'],
    ]);
    const after = new Map([
      ['331627101', 'Testoboon Depot Injection'],
      ['998877665', 'Test E Injection'],
    ]);

    assert.deepEqual(collateralRenames(before, after, '331627101'), [
      'item 998877665: "Some Other Live Product" -> "Test E Injection"',
    ]);
  });

  await t.test('the listing being worked on may change name', () => {
    const before = new Map([['331627101', 'Old Name']]);
    const after = new Map([['331627101', 'New Name']]);
    assert.deepEqual(collateralRenames(before, after, '331627101'), []);
  });

  await t.test('a listing leaving the Active tab is not a rename', () => {
    const before = new Map([['331627101', 'Kept'], ['998877665', 'Deactivated Later']]);
    const after = new Map([['331627101', 'Kept']]);
    assert.deepEqual(collateralRenames(before, after, '331627101'), []);
  });
});

test('active listing names are read with their item ids', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const uploader = new Uploader();
  uploader.page = page;
  t.after(() => browser.close());

  await page.setContent(`
    <div>Active (2)</div>
    <a class="MPSD_prdname" id="itemName331627101">Testoboon Depot Injection</a>
    <a class="MPSD_prdname" id="itemName998877665">Test E Injection</a>
    <a class="MPSD_prdname" id="notAnItem">Ignored</a>`);

  const names = await uploader._activeNamesById();
  assert.deepEqual(
    [...names.entries()].sort(),
    [
      ['331627101', 'Testoboon Depot Injection'],
      ['998877665', 'Test E Injection'],
    ],
  );
});

/**
 * A listing's group is read back off its Manage Products card after being set —
 * the click is never trusted on its own. Verified live: setting the group on
 * item 331659172 created "Erectile Dysfunction" and put that product in it.
 */
test('the group is read back from the listing card', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const uploader = new Uploader();
  uploader.page = page;
  t.after(() => browser.close());

  await t.test('reads the group shown on the card', async () => {
    await page.setContent(`
      <div class="MPSD_prdlstcont">
        <a class="MPSD_prdname" id="itemName331659172">Vilitra 10mg Vardenafil Tablet</a>
        <div>Category<br>Vardenafil Tablet</div>
        <div><span style="display:block">Group</span><span style="display:block">Erectile Dysfunction</span></div>
      </div>`);
    const card = page.locator('div.MPSD_prdlstcont');
    assert.equal(await uploader._cardGroup(card), 'Erectile Dysfunction');
  });

  await t.test('reports no group rather than guessing one', async () => {
    await page.setContent(`
      <div class="MPSD_prdlstcont">
        <a class="MPSD_prdname" id="itemName1">Some Product</a>
        <div>Category<br>Vardenafil Tablet</div>
      </div>`);
    assert.equal(await uploader._cardGroup(page.locator('div.MPSD_prdlstcont')), '');
  });
});
