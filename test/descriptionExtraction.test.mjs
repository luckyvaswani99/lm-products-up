/**
 * A whole catalogue extracted with an empty description.
 *
 * All 40 products of silverlinemedicare/anti-depressants came back with 0
 * description characters while their specifications and photo arrived fine. The
 * pages do carry a description — 183 to 1,561 characters of it — but under
 * #descp2 / .pro-descN, and none of the ids the scraper looked for exist on
 * those pages at all. The run reported "40 with specifications, 40 with photos"
 * and said nothing about descriptions, so it looked like a success.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { extractDetail } from '../src/scraper/indiamartScraper.js';

const REAL_TEXT =
  'Bupron XL 150 Tablet is used in the treatment of depression and smoking addiction. ' +
  'This medicine helps by increasing the levels of chemical messengers in the brain that ' +
  'regulate mood, and it is taken with or without food as advised.';

test('the description is read whatever the page calls its block', async (t) => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  const pageWith = (markup) =>
    page.setContent(`<h1>Bupron Xl 150 Mg Tablet</h1>${markup}
      <table><tr><td>Strength</td><td>150 mg</td></tr></table>`);

  await t.test('#descp2, the block these product pages actually use', async () => {
    await pageWith(`<div id="descp2">${REAL_TEXT}</div>`);
    const detail = await extractDetail(page, 'https://example.test/p.html', { navigate: false });
    assert.match(detail.description, /used in the treatment of depression/);
  });

  await t.test('.pro-descN, the same block by class', async () => {
    await pageWith(`<div class="pro-descN">${REAL_TEXT}</div>`);
    const detail = await extractDetail(page, 'https://example.test/p.html', { navigate: false });
    assert.match(detail.description, /used in the treatment of depression/);
  });

  await t.test('the older containers still win when a page has one', async () => {
    // The list is ordered, so pages served the previous markup are unaffected.
    const older = 'The description as the older product pages carry it, well past the length floor.';
    await pageWith(`<div id="prod-desc">${older}</div><div id="descp2">${REAL_TEXT}</div>`);
    const detail = await extractDetail(page, 'https://example.test/p.html', { navigate: false });
    assert.equal(detail.description, older);
  });

  await t.test('a stub too short to be a description is passed over', async () => {
    // firstText enforces a 30-character floor, which is what stops an empty
    // shell of the old markup from shadowing the real block below it.
    await pageWith(`<div id="prod-desc">Description</div><div id="descp2">${REAL_TEXT}</div>`);
    const detail = await extractDetail(page, 'https://example.test/p.html', { navigate: false });
    assert.match(detail.description, /used in the treatment of depression/);
  });

  await t.test('a page with no description block reports none, never a guess', async () => {
    await pageWith('<div id="unrelated">Contact Supplier</div>');
    const detail = await extractDetail(page, 'https://example.test/p.html', { navigate: false });
    assert.equal(detail.description, '');
  });
});

test('a catalogue run counts the descriptions it got', async (t) => {
  const source = fs.readFileSync(new URL('../src/scraper/catalogScraper.js', import.meta.url), 'utf8');

  await t.test('the summary reports them next to specs and photos', () => {
    assert.match(source, /const withDescription = results\.filter/);
    assert.match(source, /\$\{withDescription\} with a description/);
  });

  await t.test('a shortfall is called out, not left to be noticed later', () => {
    assert.match(source, /if \(withDescription < results\.length\)/);
    assert.match(source, /have no description/);
  });
});
