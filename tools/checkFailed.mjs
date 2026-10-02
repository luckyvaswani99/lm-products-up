/**
 * For every product this tool reported as NOT uploaded, ask the account
 * whether a listing exists anyway.
 *
 * Needed before any retry. Some failures happen after Finish — "live but
 * incomplete", "did not expose the new exact product after Finish" — so the
 * listing can be on the account while the product reads as failed. Retrying
 * those blind is how a duplicate pair gets created.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { log } from '../src/logger.js';
import { Store, slugify } from '../src/store.js';
import { Uploader, uploadProductName } from '../src/uploader/indiamartUploader.js';

const store = await new Store().load();
const failed = store.all().filter((product) => product.status.uploaded === 'error');
log.step(`checking ${failed.length} product(s) reported as NOT uploaded against the account`);

const up = new Uploader();
await up.open();
const rows = [];
try {
  for (const [index, product] of failed.entries()) {
    const name = uploadProductName(product);
    // eslint-disable-next-line no-await-in-loop
    const matches = await up._searchProducts(name).catch(() => null);
    const exact = (matches || []).filter((row) => row.itemId && slugify(row.name) === slugify(name));
    const reason = String(product.errors.uploaded || '').split('\n')[0];
    const row = {
      id: product.id,
      name,
      lane: product.lane,
      reason: reason.slice(0, 90),
      onAccount: exact.length,
      itemIds: exact.map((match) => match.itemId),
      verdict: matches === null ? 'search-failed' : exact.length === 0 ? 'safe-to-retry' : exact.length === 1 ? 'ALREADY LIVE' : 'DUPLICATE',
    };
    rows.push(row);
    log.info(`  ${index + 1}/${failed.length} ${row.verdict.padEnd(13)} ${name.slice(0, 36).padEnd(36)} ${row.itemIds.join(', ')}`);
  }
} finally {
  await up.close().catch(() => {});
}

const out = path.join(config.dataDir, 'check-failed.json');
fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
const by = (verdict) => rows.filter((row) => row.verdict === verdict);
log.ok(`checked ${rows.length} -> ${out}`);
log.info(`  safe to retry (not on the account): ${by('safe-to-retry').length}`);
if (by('ALREADY LIVE').length) {
  // These are the ones that publish and then report an error — the failure
  // happens after Finish, so the listing is on the account and the product
  // reads as failed. A retry is only safe while the duplicate lookup is on:
  // then addProduct finds the listing by name and completes it in place.
  // With the lookup off, the same retry creates a second listing.
  log.warn(
    `  ALREADY LIVE despite the error    : ${by('ALREADY LIVE').length} — ` +
      'retry only with "Find duplicates: on", which reconciles them instead of creating again',
  );
  by('ALREADY LIVE').forEach((row) => log.warn(`    ${row.name.slice(0, 40)} item ${row.itemIds[0]} — ${row.reason}`));
}
if (by('DUPLICATE').length) {
  log.error(`  already DUPLICATED on the account : ${by('DUPLICATE').length}`);
  by('DUPLICATE').forEach((row) => log.error(`    ${row.name.slice(0, 40)} — ${row.itemIds.join(', ')}`));
}
