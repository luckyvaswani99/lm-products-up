/**
 * Check every product this tool reported as published against the live account.
 *
 * The run's own log is not evidence: it says what the uploader believed, and
 * this project has already seen a product reported as failed that was in fact
 * created, and a pair of duplicates created by a run that reported success. So
 * each published product is searched on Manage Products and judged by what the
 * account actually shows.
 *
 *   node tools/verifyPublished.mjs            check every published product
 *   node tools/verifyPublished.mjs 20         check the first 20
 *
 * Writes data/verify-published.json and prints a summary. Read-only: it
 * searches and reads, and changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { log } from '../src/logger.js';
import { Store } from '../src/store.js';
import { Uploader, uploadProductName } from '../src/uploader/indiamartUploader.js';
import { slugify } from '../src/store.js';

const wanted = Number(process.argv[2]) || 0;
const store = await new Store().load();
const published = store.all().filter((product) => product.status.uploaded === 'done');
const todo = wanted ? published.slice(0, wanted) : published;

log.step(`verifying ${todo.length} published product(s) against the account`);

const up = new Uploader();
await up.open();
const rows = [];
try {
  for (const [index, product] of todo.entries()) {
    const name = uploadProductName(product);
    // eslint-disable-next-line no-await-in-loop
    const matches = await up._searchProducts(name).catch((error) => {
      log.warn(`  search failed for ${name.slice(0, 40)}: ${error.message.split('\n')[0]}`);
      return null;
    });
    if (matches === null) {
      rows.push({ id: product.id, name, verdict: 'search-failed' });
      continue;
    }
    const exact = matches.filter((row) => row.itemId && slugify(row.name) === slugify(name));
    const row = { id: product.id, name, lane: product.lane, group: product.group, found: exact.length };
    if (!exact.length) {
      row.verdict = 'MISSING';
    } else if (exact.length > 1) {
      row.verdict = 'DUPLICATE';
      row.itemIds = exact.map((match) => match.itemId);
    } else {
      row.verdict = 'ok';
      row.itemId = exact[0].itemId;
      // What the listing actually carries, not what we sent.
      const live = { ...exact[0], card: up.page.locator(`#${exact[0].anchorId}`).locator('xpath=ancestor::div[contains(@class,"MPSD_prdlstcont")][1]') };
      // eslint-disable-next-line no-await-in-loop
      row.photos = (await up._livePhotoUrls(live).catch(() => [])).length;
      // eslint-disable-next-line no-await-in-loop
      row.liveGroup = await up._cardGroup(live.card).catch(() => '');
      row.groupOk = !product.group || row.liveGroup === product.group;
      row.wantedPhotos = (product.localImages || []).length;
    }
    rows.push(row);
    log.info(
      `  ${index + 1}/${todo.length} ${row.verdict.padEnd(9)} ${name.slice(0, 38).padEnd(38)} ` +
        `${row.itemId ? `item ${row.itemId}` : ''} ${row.photos !== undefined ? `${row.photos}/${row.wantedPhotos} photo(s)` : ''}` +
        `${row.liveGroup ? ` group "${row.liveGroup}"` : ''}`,
    );
  }
} finally {
  await up.close().catch(() => {});
}

const by = (verdict) => rows.filter((row) => row.verdict === verdict);
const out = path.join(config.dataDir, 'verify-published.json');
fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');

log.ok(`verified ${rows.length} product(s) -> ${out}`);
log.info(`  on the account, exactly once : ${by('ok').length}`);
if (by('DUPLICATE').length) {
  log.error(`  DUPLICATE listings          : ${by('DUPLICATE').length}`);
  by('DUPLICATE').forEach((row) => log.error(`    ${row.name.slice(0, 45)} — ${row.itemIds.join(', ')}`));
}
if (by('MISSING').length) {
  log.error(`  reported published, NOT there: ${by('MISSING').length}`);
  by('MISSING').forEach((row) => log.error(`    ${row.name.slice(0, 50)}`));
}
if (by('search-failed').length) log.warn(`  could not be searched        : ${by('search-failed').length}`);

const shortPhotos = by('ok').filter((row) => row.photos < row.wantedPhotos);
if (shortPhotos.length) {
  log.warn(`  fewer photos than we prepared: ${shortPhotos.length}`);
  shortPhotos.forEach((row) => log.warn(`    ${row.name.slice(0, 40)} — ${row.photos}/${row.wantedPhotos}`));
}
const wrongGroup = by('ok').filter((row) => !row.groupOk);
if (wrongGroup.length) {
  log.warn(`  not in the group their lane wanted: ${wrongGroup.length}`);
}
