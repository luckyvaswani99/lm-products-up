/**
 * Three things a run should not have to pay for.
 *
 * 1. Finding an existing listing meant crawling every lazily rendered row on an
 *    account that now holds 501 of them — ~25s a pass. The portal's own search
 *    box answers in seconds, and a button turns the lookup off entirely.
 * 2. AI copywriting costs money per product, while the scraped description and
 *    specification table are already complete and true to the source.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { loadSeoSettings, saveSeoSettings } from '../src/ai/seoSettings.js';

const settingsFile = new URL('../data/seo-settings.json', import.meta.url);
const restore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
test.after(() => {
  if (restore === null) fs.rmSync(settingsFile, { force: true });
  else fs.writeFileSync(settingsFile, restore);
});

test('AI listing copy can be switched off without losing it', async (t) => {
  await t.test('it is on unless it was turned off', () => {
    fs.rmSync(settingsFile, { force: true });
    assert.equal(loadSeoSettings().ai, true);
  });

  await t.test('the choice survives a restart', () => {
    assert.equal(saveSeoSettings({ ai: false }).ai, false);
    assert.equal(loadSeoSettings().ai, false);
    assert.equal(saveSeoSettings({ ai: true }).ai, true);
    assert.equal(loadSeoSettings().ai, true);
  });

  await t.test('an unrelated write does not flip it', () => {
    saveSeoSettings({ ai: false });
    assert.equal(saveSeoSettings({}).ai, false, 'ai stays off when the field is absent');
  });

  await t.test('a damaged file falls back to on rather than silently skipping AI', () => {
    fs.writeFileSync(settingsFile, '{ not json');
    assert.equal(loadSeoSettings().ai, true);
  });
});

test('the SEO stage publishes scraped text when AI copy is off', async (t) => {
  const source = fs.readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');

  await t.test('it does not call the copywriter at all', () => {
    const stage = source.slice(source.indexOf('export async function runSeo'));
    const guard = stage.indexOf('if (!loadSeoSettings().ai)');
    const call = stage.indexOf('await generateSeo(');
    assert.ok(guard > -1 && call > -1, 'both the guard and the AI call exist');
    assert.ok(guard < call, 'the guard returns before any AI call is reached');
  });

  await t.test('products are marked skipped, not done — nothing was written', () => {
    assert.match(source, /store\.markStage\(p, 'seo', 'skipped'\)/);
  });

  await t.test('a product with no source text to upload is named', () => {
    assert.match(source, /source has \$\{characters\} description character\(s\)/);
  });
});

/**
 * The duplicate lookup can be turned off — and stay off.
 *
 * The toggle used to live only in the page, so a refresh put it back to "on"
 * without a word and the next run searched the account after being told not
 * to. The choice is saved on the server now, and the run reads it from there.
 */
test('the upload toggles are saved, not held in the page', async (t) => {
  const { loadUploadSettings, saveUploadSettings } = await import('../src/uploadSettings.js');
  const file = new URL('../data/upload-settings.json', import.meta.url);
  const restore = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  t.after(() => {
    if (restore === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, restore);
  });

  await t.test('both are on until they are turned off', () => {
    fs.rmSync(file, { force: true });
    assert.deepEqual(loadUploadSettings(), { findDuplicates: true, brochurePageInGallery: true });
  });

  await t.test('a choice survives a restart', () => {
    saveUploadSettings({ findDuplicates: false });
    assert.equal(loadUploadSettings().findDuplicates, false);
    assert.equal(loadUploadSettings().brochurePageInGallery, true, 'the other toggle is untouched');
  });

  await t.test('a damaged file falls back to on, never to silently skipping', () => {
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(loadUploadSettings(), { findDuplicates: true, brochurePageInGallery: true });
  });
});

test('a run obeys the saved toggle', async (t) => {
  const pipeline = fs.readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  const uploader = fs.readFileSync(new URL('../src/uploader/indiamartUploader.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  await t.test('the setting decides when the request says nothing', () => {
    assert.match(pipeline, /!loadUploadSettings\(\)\.findDuplicates/);
    assert.match(pipeline, /addProduct\(p, \{ dryRun, skipDuplicateCheck \}\)/);
  });

  await t.test('the page sends no toggle state of its own', () => {
    // A stale page must not be able to make a run behave differently from
    // what the toolbar shows.
    assert.doesNotMatch(app, /skipDuplicateCheck: \$\('#skipDuplicateBtn'\)/);
    assert.match(app, /api\('PUT', '\/api\/upload-settings'/);
  });

  await t.test('it only skips the lookup, never the verification', () => {
    assert.match(uploader, /skipDuplicateCheck \? null : await this\._timed\('look up by name'/);
    const add = uploader.slice(uploader.indexOf('async addProduct('));
    assert.match(add, /_findActiveProduct\(product\)/, 'the result is still looked up after Finish');
    assert.match(add, /_assertOnlyTouched\(/, 'the collateral-rename check still runs');
  });

  await t.test('the run says when the lookup was off', () => {
    assert.match(pipeline, /duplicate lookup off/);
  });

  await t.test('the PDF is attached either way; only its gallery page is optional', () => {
    const pdf = uploader.slice(uploader.indexOf('async _uploadPdfOnce'));
    assert.match(pdf, /loadUploadSettings\(\)\.brochurePageInGallery/);
    // The attachment is verified before the dialog is even considered.
    assert.ok(
      pdf.indexOf('View PDF') < pdf.indexOf('brochurePageInGallery'),
      'the PDF is confirmed attached before the gallery choice is made',
    );
  });

  await t.test('a clean finish is verified rather than rewritten', () => {
    assert.match(uploader, /verifyOnly = false/);
    assert.match(uploader, /verifyOnly: true/);
    assert.match(uploader, /verification found something to repair/);
  });
});

/**
 * Controls that are visible, enabled and stable, and still cannot be clicked.
 *
 * Seen mid-run on three separate products: the crop popup's "Upload Photo"
 * button bounced off `<div class="photodocouterdiv">` left behind by the file
 * picker, and Finish bounced off a leftover portal layer while the failure
 * screenshot showed it green and ready. Each cost ten seconds of retries and
 * then the product.
 */
test('a control behind a stale overlay is still reached', async (t) => {
  const { chromium } = await import('playwright');
  const uploader = fs.readFileSync(new URL('../src/uploader/indiamartUploader.js', import.meta.url), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  t.after(() => browser.close());

  const clickThrough = uploader.match(/async function clickThrough\([\s\S]*?\n}/)?.[0];
  assert.ok(clickThrough, 'clickThrough must exist');

  /** An overlay covering the button, exactly as the portal leaves one. */
  const setup = async (covered) => {
    await page.setContent(`
      <button id="go" onclick="window.fired = true">Upload Photo</button>
      ${covered ? '<div class="photodocouterdiv" style="position:fixed;inset:0"></div>' : ''}`);
    await page.evaluate(() => { window.fired = false; });
  };
  const run = () =>
    page.evaluate(async (source) => {
      const el = document.getElementById('go');
      const locator = {
        click: () => {
          const top = document.elementFromPoint(
            el.getBoundingClientRect().x + 2,
            el.getBoundingClientRect().y + 2,
          );
          if (top !== el) return Promise.reject(new Error('… subtree intercepts pointer events'));
          el.click();
          return Promise.resolve();
        },
        evaluate: (fn) => Promise.resolve(fn(el)),
      };
      // eslint-disable-next-line no-new-func
      const fn = new Function(`${source}\nreturn clickThrough;`)();
      return fn(locator, 500);
    }, clickThrough);

  await t.test('an ordinary click is used when nothing is in the way', async () => {
    await setup(false);
    assert.equal(await run(), 'clicked');
    assert.equal(await page.evaluate(() => window.fired), true);
  });

  await t.test('the handler is reached when an overlay intercepts', async () => {
    await setup(true);
    assert.equal(await run(), 'clicked through an overlay');
    assert.equal(await page.evaluate(() => window.fired), true, 'the button’s own handler ran');
  });

  await t.test('any other click failure is still raised', async () => {
    const thrown = await page.evaluate((source) => {
      const locator = { click: () => Promise.reject(new Error('element is not enabled')) };
      // eslint-disable-next-line no-new-func
      const fn = new Function(`${source}\nreturn clickThrough;`)();
      return fn(locator, 10).then(() => null, (e) => e.message);
    }, clickThrough);
    assert.match(thrown, /not enabled/);
  });

  await t.test('a unit only the portal may choose is reported, never failed', () => {
    // IndiaMART answers a typed "Stripe" with its own "Strip", and will not
    // take a new unit on an existing listing at all. On a 40-product batch
    // where 34 carry "Stripe", failing that check rewrote every product to
    // arrive at exactly the same value.
    const verify = uploader.slice(uploader.indexOf('const unitIsOurs') >= 0 ? uploader.indexOf('const unitIsOurs') : uploader.indexOf('slugify(openedUnit)'));
    assert.doesNotMatch(verify.slice(0, 600), /throw new Error\([^)]*retained unit/);
    assert.match(uploader, /carries unit "\$\{openedUnit\}" where the product says/);
  });
});

/**
 * How many times one product makes the account search.
 *
 * Each search is a typed query plus Enter plus the list settling — about four
 * seconds. A product was running four of them: the duplicate lookup, the
 * baseline for the collateral check, the post-Finish lookup, and the collateral
 * check itself. The first two ask the same page the same word a moment apart,
 * and the last two are separated by nothing that writes.
 */
test('one product does not search the account over and over', async (t) => {
  const uploader = fs.readFileSync(new URL('../src/uploader/indiamartUploader.js', import.meta.url), 'utf8');
  const addProduct = uploader.slice(uploader.indexOf('async addProduct('));

  await t.test('the lookup also yields the baseline, so the name is searched once', () => {
    assert.match(uploader, /async _lookupByName\(product\)/);
    assert.match(uploader, /return \{ match: \{ \.\.\.row, anchor, card \}, sameNamed \}/);
    assert.match(addProduct, /lookup\?\.sameNamed \?\? \(await this\._timed\('name snapshot'/);
  });

  await t.test('a repair-free run reuses the reading it already took', () => {
    assert.match(addProduct, /repairedAfterRead \? null : found\.sameNamed/);
    assert.match(uploader, /knownAfter = null/);
  });

  await t.test('a repair still forces a fresh read', () => {
    // Something was written after the listing was read, so the earlier
    // reading can no longer answer the question.
    assert.match(addProduct, /repairedAfterRead = true;/);
    assert.match(uploader, /if \(!idsAfter\) \{\s*\n\s*await this\.gotoManage\(\);/);
  });

  await t.test('the lookup tries one spelling, not every spelling in turn', () => {
    const lookup = uploader.slice(uploader.indexOf('async _lookupByName('));
    assert.match(lookup.slice(0, 1200), /if \(matches\.length\) break;/);
  });
});
