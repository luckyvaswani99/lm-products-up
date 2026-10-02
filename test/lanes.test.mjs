/**
 * Guards for running five category lanes at once.
 *
 * The shared product store is the dangerous part: it is one JSON file read
 * whole and written whole, so five lanes doing load → change → save would lose
 * four lanes' progress to whichever lane saved last. Ownership is the other
 * half — the seller lists the same product under more than one category, and
 * two lanes uploading it would create the duplicate pair this account already
 * has one of.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { LaneStore } from '../src/parallel/laneStore.js';
import { DEFAULT_LANES, laneSessionDir, normaliseLane } from '../src/parallel/laneConfig.js';

const temporaryStore = (t, products = []) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-')), 'products.json');
  fs.writeFileSync(file, JSON.stringify(products));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  return file;
};

const product = (id, name = id) => ({
  id,
  name,
  price: '100',
  unit: 'Strip',
  description: 'real scraped copy',
  specs: { Form: 'Tablet' },
  imageUrls: ['https://example.invalid/a.jpg'],
  localImages: [],
  aiImages: [],
  seo: null,
  status: { scraped: 'done', images: 'done', seo: 'skipped', uploaded: 'pending' },
  errors: {},
});

test('every lane’s change to the shared store survives', async (t) => {
  const file = temporaryStore(t, [product('a'), product('b'), product('c'), product('d'), product('e')]);
  const laneStore = new LaneStore(await new Store(file).load());
  await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((id) =>
      laneStore.write(async (store) => {
        const found = store.get(id);
        await new Promise((resolve) => setImmediate(resolve));
        store.markStage(found, 'uploaded', 'done');
      }),
    ),
  );

  const reloaded = await new Store(file).load();
  assert.deepEqual(
    reloaded.all().map((p) => p.status.uploaded),
    ['done', 'done', 'done', 'done', 'done'],
    'all five lanes’ marks are on disk, not just the last one',
  );
});

test('a product listed in two categories belongs to one lane', async (t) => {
  const file = temporaryStore(t, [product('shared-one'), product('only-mens')]);
  const laneStore = new LaneStore(await new Store(file).load());

  const mens = await laneStore.claimFor('mens-health', ['shared-one', 'only-mens']);
  const pain = await laneStore.claimFor('pain-killer-medicines', ['shared-one']);

  assert.deepEqual(mens.products.map((p) => p.id), ['shared-one', 'only-mens']);
  assert.deepEqual(pain.products.map((p) => p.id), [], 'the second lane gets nothing it would duplicate');
  assert.deepEqual([...pain.takenBy], [['shared-one', 'mens-health']], 'and it is told who owns it');
});

test('claiming skips ids the store does not have rather than inventing them', async (t) => {
  const file = temporaryStore(t, [product('real')]);
  const laneStore = new LaneStore(await new Store(file).load());
  const claimed = await laneStore.claimFor('lane', ['real', 'never-scraped']);
  assert.deepEqual(claimed.products.map((p) => p.id), ['real']);
  assert.equal(claimed.takenBy.size, 0);
});

test('a lane that throws mid-write leaves the store usable for the others', async (t) => {
  const file = temporaryStore(t, [product('a'), product('b')]);
  const laneStore = new LaneStore(await new Store(file).load());

  await assert.rejects(
    () => laneStore.write(() => { throw new Error('lane blew up'); }),
    /lane blew up/,
  );
  await laneStore.write((store) => store.markStage(store.get('b'), 'uploaded', 'done'));

  const reloaded = await new Store(file).load();
  assert.equal(reloaded.get('b').status.uploaded, 'done', 'the next lane still got its turn');
  assert.equal(laneStore.lock.held, false);
});

test('the five configured lanes each get their own browser profile', () => {
  const dirs = DEFAULT_LANES.map((lane) => laneSessionDir(lane.id));
  assert.equal(new Set(dirs).size, 5, 'no two lanes share a Chromium profile');
  // One profile driven by two processes fails with "Opening in existing
  // browser session", so this is what makes five windows possible at all.
  dirs.forEach((dir) => assert.match(dir, /[\\/]\.session-lanes[\\/]/));
});

test('the configured lanes are the five categories, with no guessed group', () => {
  assert.equal(DEFAULT_LANES.length, 5);
  assert.deepEqual(
    DEFAULT_LANES.map((lane) => lane.id),
    [
      'nervous-system-medicines',
      'female-health-care-product',
      'mens-health',
      'pain-killer-medicines',
      'anti-cancer-medicines',
    ],
  );
  // The account has no pain-killer group, so a category name is not a group
  // name. The mapping is the seller's decision, not something to infer.
  DEFAULT_LANES.forEach((lane) => assert.equal(lane.group, ''));
});

test('a lane URL that is not an IndiaMART category page is refused', () => {
  assert.throws(() => normaliseLane({ url: '' }), /no category URL/);
  assert.throws(() => normaliseLane({ url: 'not a url' }), /is not a URL/);
  assert.throws(
    () => normaliseLane({ url: 'https://example.com/x.html' }),
    /is not indiamart\.com/,
  );
});

test('a lane id is derived from its URL and is safe as a directory name', () => {
  const lane = normaliseLane({
    url: 'https://www.indiamart.com/silverlinemedicare/pain-killer-medicines.html',
    group: '  Anti Cancer Medicine  ',
  });
  assert.equal(lane.id, 'pain-killer-medicines');
  assert.equal(lane.group, 'Anti Cancer Medicine', 'trimmed, so a stray space is not a different group');
  assert.equal(lane.enabled, true);
  assert.doesNotMatch(lane.id, /[^a-z0-9-]/);
});
