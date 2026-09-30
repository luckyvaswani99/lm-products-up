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

test('the duplicate lookup can be turned off for a run', async (t) => {
  const pipeline = fs.readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  const uploader = fs.readFileSync(new URL('../src/uploader/indiamartUploader.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  await t.test('the option reaches the uploader', () => {
    assert.match(pipeline, /skipDuplicateCheck = false/);
    assert.match(pipeline, /addProduct\(p, \{ dryRun, skipDuplicateCheck \}\)/);
  });

  await t.test('it only skips the lookup, never the verification', () => {
    assert.match(uploader, /skipDuplicateCheck \? null : await this\._findActiveProduct\(product\)/);
    // What proves the upload worked runs either way.
    const add = uploader.slice(uploader.indexOf('async addProduct('));
    assert.match(add, /_findActiveProduct\(product\)/, 'the result is still looked up after Finish');
    assert.match(add, /_assertOnlyTouched\(/, 'the collateral-rename check still runs');
  });

  await t.test('the button sends its state with the upload', () => {
    assert.match(app, /skipDuplicateCheck: \$\('#skipDuplicateBtn'\)\?\.getAttribute\('aria-pressed'\) === 'true'/);
  });

  await t.test('the run says when the lookup was off', () => {
    assert.match(pipeline, /duplicate lookup off/);
  });
});
