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
import { Uploader } from '../src/uploader/indiamartUploader.js';
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

/**
 * Manage Products is searched, not scrolled.
 *
 * Recorded on the live account (501 Active listings): loading every lazily
 * rendered row took ~25s per pass and left the page ~87,000 px tall. The
 * portal's own "Search Products" box answers in seconds — but only to typed
 * keystrokes followed by Enter, and it matches on substrings, so the exact-name
 * filter still decides what counts as the same listing.
 */
test('listings are found through the portal search box', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const uploader = new Uploader();
  uploader.page = page;
  t.after(() => browser.close());

  /** The search box as the portal renders it, filtering on Enter. */
  const managePage = async (listings) => {
    await page.setContent(`
      <div>Active (${listings.length})</div>
      <input id="searchProduct" placeholder="Search Products" />
      <div id="rows"></div>`);
    await page.evaluate((all) => {
      const render = (shown) => {
        document.getElementById('rows').innerHTML = shown
          .map((l) => `<a class="MPSD_prdname" id="itemName${l.id}">${l.name}</a>`)
          .join('');
      };
      render(all.slice(0, 2)); // the portal shows a short default list
      const box = document.getElementById('searchProduct');
      box.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const term = box.value.trim().toLowerCase();
        render(term ? all.filter((l) => l.name.toLowerCase().includes(term)) : all.slice(0, 2));
      });
    }, listings);
  };

  const CATALOGUE = [
    { id: '332821858', name: 'Thalix Capsules' },
    { id: '332821856', name: 'Thalix Capsules' },
    { id: '330862807', name: '100mg Thalix Thalidomida Capsule' },
    { id: '330862804', name: '100mg Thycad Thalidomide Capsule' },
  ];

  await t.test('a typed search returns only the matching rows', async () => {
    await managePage(CATALOGUE);
    const rows = await uploader._searchProducts('Thalix Capsules');
    assert.deepEqual(rows.map((r) => r.itemId), ['332821858', '332821856']);
  });

  await t.test('a word matches more widely, as the portal does', async () => {
    await managePage(CATALOGUE);
    const rows = await uploader._searchProducts('Thalix');
    assert.equal(rows.length, 3);
  });

  await t.test('only exact names count as the same listing', async () => {
    await managePage(CATALOGUE);
    const ids = await uploader._itemIdsNamed('100mg Thalix Thalidomida Capsule');
    assert.deepEqual([...ids.keys()], ['330862807']);
  });

  await t.test('a product the account does not carry returns nothing', async () => {
    await managePage(CATALOGUE);
    assert.equal((await uploader._searchProducts('Accuret')).length, 0);
    assert.equal((await uploader._itemIdsNamed('Accuret')).size, 0);
  });

  await t.test('two listings of one name are both reported, never picked between', async () => {
    await managePage(CATALOGUE);
    const ids = await uploader._itemIdsNamed('Thalix Capsules');
    assert.deepEqual([...ids.keys()].sort(), ['332821856', '332821858']);
    // Both item ids are named, because one of them has to be deleted before
    // the product can be reconciled — "refusing to choose" alone is a dead end.
    await assert.rejects(
      () => uploader._findActiveProduct({ name: 'Thalix Capsules' }),
      (error) =>
        /refusing to choose one automatically/i.test(error.message) &&
        error.message.includes('item 332821858') &&
        error.message.includes('item 332821856'),
    );
  });
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
