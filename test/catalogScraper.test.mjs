/**
 * Card extraction for a seller category page.
 *
 * The markup mirrors the live page that returned 0 products with the old
 * selectors (https://www.indiamart.com/kyvex-global/pain-killer-medicines.html):
 * cards are `li.cat-slider__card`, their own anchors are in-page (`#<id>`), and
 * the product-page links sit outside the cards and are joined by the numeric id.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { extractCatalogCards, isCatalogPage } from '../src/scraper/catalogScraper.js';

const CATEGORY_PAGE = `
<div class="category-page">
  <section class="cat-slider cat-slider--category">
    <div class="cat-slider__viewport"><ul class="cat-slider__track">
      <li class="cat-slider__card" id="2859563847962">
        <a href="#2859563847962"><figure class="cat-slider__figure">
          <img src="https://5.imimg.com/data5/SELLER/Default/2026/7/626342999/EH/UO/LW/241765141/page-001-125x125.jpg"
               alt="1000mg Soma Boost Carisoprodol Tablets USP">
        </figure></a>
        <div class="cat-slider__info">
          <a class="cat-slider__name-link" href="#2859563847962">
            <p class="cat-slider__name">1000mg Soma Boost Carisoprodol Tablets USP</p>
          </a>
          <p class="cat-slider__price">₹ 600/Pack</p>
        </div>
      </li>
      <li class="cat-slider__card" id="2859575735033">
        <div class="cat-slider__info">
          <p class="cat-slider__name">30mg Skelebenz Cyclobenzaprine Hydrochloride Tablet</p>
          <p class="cat-slider__price">₹ 300/Pack</p>
        </div>
      </li>
    </ul></div>
  </section>
  <!-- product-page links live outside the cards -->
  <a href="https://www.indiamart.com/proddetail/1000mg-soma-boost-carisoprodol-tablets-usp-2859563847962.html">x</a>
</div>`;

test('reads every product card on a seller category page', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());
  await page.setContent(CATEGORY_PAGE);

  assert.equal(await isCatalogPage(page), true);
  const cards = await extractCatalogCards(page);
  assert.equal(cards.length, 2);

  await t.test('joins a card to its product page by id and upsizes the image', () => {
    assert.deepEqual(cards[0], {
      id: '2859563847962',
      name: '1000mg Soma Boost Carisoprodol Tablets USP',
      priceText: '₹ 600/Pack',
      image:
        'https://5.imimg.com/data5/SELLER/Default/2026/7/626342999/EH/UO/LW/241765141/page-001-1000x1000.jpg',
      detailUrl:
        'https://www.indiamart.com/proddetail/1000mg-soma-boost-carisoprodol-tablets-usp-2859563847962.html',
    });
  });

  await t.test('keeps a card with no product page link, without inventing one', () => {
    assert.equal(cards[1].name, '30mg Skelebenz Cyclobenzaprine Hydrochloride Tablet');
    assert.equal(cards[1].priceText, '₹ 300/Pack');
    assert.equal(cards[1].detailUrl, '');
  });
});

test('a page with no product cards is not treated as a catalog', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  await page.setContent('<div class="prd_card">Some other IndiaMART layout</div>');
  assert.equal(await isCatalogPage(page), false);
  assert.deepEqual(await extractCatalogCards(page), []);
});
