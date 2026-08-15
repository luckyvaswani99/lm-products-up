/**
 * Completeness gate for the upload stage.
 *
 * 15 products went live with "6 missing" on their IndiaMART card because the
 * product page read returned nothing, the empty result was accepted silently,
 * and the upload ran anyway. Nothing may be published unless its own record
 * actually carries specifications, images and a description.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadBlockers } from '../src/pipeline.js';

const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-ready-'));
const imageFile = path.join(imageDir, 'photo.jpg');
fs.writeFileSync(imageFile, 'x');
test.after(() => fs.rmSync(imageDir, { recursive: true, force: true }));

const complete = () => ({
  name: '1000mg Soma Boost Carisoprodol Tablets USP',
  description: 'Real scraped copy.',
  specs: { Strength: '1000 mg', Brand: 'Soma Boost' },
  localImages: [imageFile],
  aiImages: [],
});

test('a complete product has nothing blocking it', () => {
  assert.deepEqual(uploadBlockers(complete()), []);
});

test('a product with no specifications is blocked', () => {
  // The exact shape of the 15 listings that went live incomplete: the card
  // thumbnail downloaded, but the product page read returned no specs.
  const product = { ...complete(), specs: {} };
  assert.deepEqual(uploadBlockers(product), ['no specifications']);
});

test('SEO specs satisfy the requirement when the scrape had none', () => {
  const product = { ...complete(), specs: {}, seo: { specs: { Strength: '750 mg' } } };
  assert.deepEqual(uploadBlockers(product), []);
});

test('a product with no images is blocked', () => {
  const product = { ...complete(), localImages: [], aiImages: [] };
  assert.deepEqual(uploadBlockers(product), ['no images']);
});

test('a product with no description is blocked', () => {
  const product = { ...complete(), description: '   ' };
  assert.deepEqual(uploadBlockers(product), ['no description']);
});

test('every missing part is reported at once, not one per run', () => {
  const product = { name: 'Empty', description: '', specs: {}, localImages: [], aiImages: [] };
  assert.deepEqual(uploadBlockers(product), ['no specifications', 'no images', 'no description']);
});

/**
 * Two stored products sharing a listing name resolve to the same live item, so
 * uploading both makes the second overwrite the first. The seller catalogue
 * that was scraped contains such a pair (Soma Dol 750mg, twice).
 */
test('products that would fight over one live listing are blocked', async (t) => {
  const { duplicateListingNames } = await import('../src/pipeline.js');

  await t.test('both sides of a clash are reported', () => {
    const a = { id: 'soma-a', name: '750mg Soma Dol Carisoprodol Tablets' };
    const b = { id: 'soma-b', name: 'Other', seo: { name: '750mg Soma Dol Carisoprodol Tablets' } };
    const clashes = duplicateListingNames([a, b]);

    assert.equal(clashes.size, 2);
    assert.match(clashes.get(a), /same listing name .* as soma-b/);
    assert.match(clashes.get(b), /same listing name .* as soma-a/);
  });

  await t.test('distinct names do not clash', () => {
    const products = [
      { id: 'a', name: '750mg Soma Dol Carisoprodol Tablets' },
      { id: 'b', name: '350mg Soma Dol Carisoprodol Tablet' },
    ];
    assert.equal(duplicateListingNames(products).size, 0);
  });
});

/**
 * A run whose Chromium session died mid-batch marked 29 untouched products
 * "error" in a few milliseconds — every one of them with the same message the
 * dead browser produced. Those products were never attempted, so they must stay
 * pending; only genuine per-product faults are failures.
 */
test('a dead browser session is told apart from a product fault', async (t) => {
  const { browserSessionGone } = await import('../src/pipeline.js');

  await t.test('recognises the messages the real aborted run recorded', () => {
    for (const message of [
      'page.goto: Target page, context or browser has been closed',
      'Gallery upload failed (3 photos): page.evaluate: Target page, context or browser has been closed',
      'Target crashed',
      'Browser closed',
    ]) {
      assert.ok(browserSessionGone(new Error(message)), message);
    }
  });

  await t.test('a real product fault is still a product fault', () => {
    for (const message of [
      'IndiaMART read only 2 of 3 photos into the crop popup within 65s',
      '2 photos could not be added Image is less than 500 x 500 px',
      'could not set required: Prescription',
      'IndiaMART opened "Some Other Tablet" instead of "Axepta 10 mg"',
    ]) {
      assert.equal(browserSessionGone(new Error(message)), false, message);
    }
  });
});

/**
 * A run must not spend an hour repeating one fault.
 *
 * Recorded on a 42-product run: after four listings went live, the next 33
 * failed one after another with the identical message 'Could not find the
 * "Add Product" button' — 65 minutes of retrying a portal problem, with the
 * real cause buried at the top of the log.
 */
test('a fault that repeats stops the run instead of consuming the queue', async (t) => {
  const { REPEATED_FAILURE_LIMIT } = await import('../src/pipeline.js');

  /** The loop's guard, applied to a sequence of per-product error messages. */
  const attemptsBeforeStopping = (messages) => {
    let lastReason = null;
    let repeats = 0;
    let attempted = 0;
    for (const message of messages) {
      attempted += 1;
      const reason = String(message).split('\n')[0].slice(0, 80);
      repeats = reason === lastReason ? repeats + 1 : 1;
      lastReason = reason;
      if (repeats >= REPEATED_FAILURE_LIMIT) break;
    }
    return attempted;
  };

  await t.test('the observed run of 33 identical failures stops early', () => {
    const observed = Array(33).fill('Could not find the "Add Product" button');
    assert.equal(attemptsBeforeStopping(observed), REPEATED_FAILURE_LIMIT);
  });

  await t.test('different faults do not add up to a stop', () => {
    // Real mix from another run: each product broken for its own reason.
    const mixed = [
      'Could not find the "Add Product" button',
      'PDF upload failed: page.waitForResponse: Timeout 30000ms exceeded',
      'Could not find the "Add Product" button',
      'page.goto: Timeout 30000ms exceeded.',
      'Could not find the "Add Product" button',
    ];
    assert.equal(attemptsBeforeStopping(mixed), mixed.length);
  });

  await t.test('a lone failure never stops a run', () => {
    assert.equal(attemptsBeforeStopping(['only this one broke']), 1);
  });
});
