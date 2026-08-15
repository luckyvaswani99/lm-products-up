/**
 * Reading a product's own photo gallery.
 *
 * Two failures shaped this. The thumbnail strip is lazy-loaded — its <img>
 * elements exist immediately but carry a shared `z.gif` until JS fills in the
 * real URLs — so reading too early captured a random 1-4 frames and every
 * re-run produced a different count. Scanning the whole document instead
 * over-collected: the "similar products" carousels render into the same page,
 * and a 3-photo product came back with 7 frames, 4 belonging to other listings.
 *
 * The gallery is therefore read from `.main-media` and `.gallery-thumbs` only,
 * after waiting for the strip to resolve. Verified live on two products, twice
 * each: page-43,42,44 and page-39,40,41 — identical on every pass.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { frameKey, fullSize, readProductGallery } from '../src/scraper/productGallery.js';

const FOLDER = 'https://5.imimg.com/data5/SELLER/Default/2026/7/625470494/TJ/VP/IY/241765141';
const PLACEHOLDER = 'https://5.imimg.com/z.gif';

/** A product page laid out like the live one, plus a related-products strip. */
const productPage = ({ thumbsResolved }) => `
  <meta property="og:image" content="${FOLDER}/page-43-500x500.png">
  <div class="main-media"><img src="${FOLDER}/page-43-1000x1000.png"></div>
  <div class="gallery-thumbs sthumn">
    <img class="image" src="${thumbsResolved ? `${FOLDER}/page-42-125x125.png` : PLACEHOLDER}">
    <img class="image" src="${thumbsResolved ? `${FOLDER}/page-44-125x125.png` : PLACEHOLDER}">
  </div>
  <section class="similar-products">
    <img src="${FOLDER}/page-39-1000x1000.png">
    <img src="${FOLDER}/page-52-1000x1000.png">
  </section>`;

test('only this product’s own frames are collected', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());
  await page.setContent(productPage({ thumbsResolved: true }));

  const gallery = await readProductGallery(page);
  const frames = gallery.images.map((url) => url.split('/').pop());

  await t.test('the whole gallery is present, primary first', () => {
    assert.deepEqual(frames, [
      'page-43-1000x1000.png',
      'page-42-1000x1000.png',
      'page-44-1000x1000.png',
    ]);
  });

  await t.test('related products are not swept in', () => {
    assert.ok(!frames.some((frame) => /page-39|page-52/.test(frame)));
  });
});

test('an unresolved strip yields the primary photo, never a wrong one', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());
  await page.setContent(productPage({ thumbsResolved: false }));

  const gallery = await readProductGallery(page);
  assert.deepEqual(
    gallery.images.map((url) => url.split('/').pop()),
    ['page-43-1000x1000.png'],
  );
});

test('the same frame quoted at several sizes counts once', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(`
    <meta property="og:image" content="${FOLDER}/page-39-500x500.png">
    <div class="main-media"><img src="${FOLDER}/page-39-1000x1000.png"></div>
    <div class="gallery-thumbs"><img class="image" src="${FOLDER}/page-39-125x125.png"></div>`);

  const gallery = await readProductGallery(page);
  assert.deepEqual(
    gallery.images.map((url) => url.split('/').pop()),
    ['page-39-1000x1000.png'],
  );
});

test('logos and template art are not treated as product photos', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent(`
    <div class="main-media">
      <img src="https://5.imimg.com/data5/SELLER/Default/2026/7/1/Logo/imLogo-1000x1000.png">
      <img src="${FOLDER}/page-39-1000x1000.png">
    </div>`);

  const gallery = await readProductGallery(page);
  assert.deepEqual(
    gallery.images.map((url) => url.split('/').pop()),
    ['page-39-1000x1000.png'],
  );
});

test('frame identity and size normalisation', async (t) => {
  await t.test('size suffix is upgraded to the largest served', () => {
    assert.equal(fullSize(`${FOLDER}/page-39-125x125.png`), `${FOLDER}/page-39-1000x1000.png`);
  });

  await t.test('the same frame at two sizes shares one key', () => {
    assert.equal(
      frameKey(`${FOLDER}/page-39-125x125.png`),
      frameKey(`${FOLDER}/page-39-1000x1000.png`),
    );
  });

  await t.test('the same frame name under another seller folder differs', () => {
    const other = FOLDER.replace('241765141', '999999999');
    assert.notEqual(frameKey(`${FOLDER}/page-39.png`), frameKey(`${other}/page-39.png`));
  });
});
