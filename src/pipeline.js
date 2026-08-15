import fsp from 'node:fs/promises';
import pLimit from 'p-limit';
import { config } from './config.js';
import { log } from './logger.js';
import { Store, slugify } from './store.js';
import { sanitizeSpecs } from './specSanitizer.js';
import { isNearMatch, listingKey } from './listingKey.js';
import { scrape, scrapeSingle } from './scraper/indiamartScraper.js';
import { readProductPages, scrapeCatalog } from './scraper/catalogScraper.js';
import { downloadImages } from './images/downloader.js';
import { regenerateImage } from './images/aiImage.js';
import { generateSeo } from './ai/seoContent.js';
import { Uploader } from './uploader/indiamartUploader.js';
import { productImageFiles } from './images/productImageFiles.js';

async function withStore(fn) {
  const store = await new Store().load();
  try {
    return await fn(store);
  } finally {
    await store.save();
  }
}

// ---------------- scrape ----------------
export async function runScrape({ urls, limit, detail = true, mode = 'auto' } = {}) {
  const list = urls?.length ? urls : config.scrape.urls;
  if (!list.length) throw new Error('No scrape URLs. Pass --url or set SCRAPE_URLS in .env');
  const raw = await scrape(list, { limit: limit ?? config.scrape.limit, detail, mode, headful: config.indiamart.headful });
  return withStore((store) => {
    let added = 0;
    for (const r of raw) {
      const { inserted } = store.upsert(r, { refresh: true });
      if (inserted) added++;
    }
    log.ok(`scraped ${raw.length} products, ${added} new (total ${store.all().length})`);
    return { scraped: raw.length, added };
  });
}

// ---------------- bulk scrape a seller category page ----------------
/**
 * Extract every product from one or more seller category pages. Kept separate
 * from runScrape so the existing listing/storefront extraction is unchanged.
 */
export async function runScrapeCatalog({ urls, limit } = {}) {
  const list = (urls || []).map((url) => String(url).trim()).filter(Boolean);
  if (!list.length) throw new Error('Paste at least one seller category page URL');
  const raw = await scrapeCatalog(list, {
    limit: limit ?? config.scrape.limit,
    headful: config.indiamart.headful,
  });
  return withStore((store) => {
    let added = 0;
    for (const record of raw) {
      const { inserted } = store.upsert(record, { refresh: true });
      if (inserted) added++;
    }
    log.ok(`catalog: ${raw.length} product(s), ${added} new (total ${store.all().length})`);
    return { scraped: raw.length, added };
  });
}

// ---------------- repair products whose specs never arrived ----------------
/**
 * Re-read the product page for every stored product that has no specifications.
 * A changed gallery invalidates the downloaded photos so the image stage runs
 * again, and only products that actually recover are queued for upload.
 */
export async function repairMissingSpecs() {
  const store = await new Store().load();
  const broken = store
    .all()
    .filter((p) => !Object.keys(p.specs || {}).length && /proddetail/.test(p.sourceUrl || ''));
  if (!broken.length) {
    log.ok('no products are missing specifications');
    return { repaired: 0, failed: 0 };
  }

  log.step(`re-reading ${broken.length} product page(s) with missing specifications`);
  const found = await readProductPages(
    broken.map((p) => p.sourceUrl),
    { headful: config.indiamart.headful },
  );

  let repaired = 0;
  for (const product of broken) {
    const detail = found.get(product.sourceUrl);
    if (!detail) continue;
    product.specs = detail.moq
      ? { ...detail.specs, 'Minimum Order Quantity': detail.moq }
      : detail.specs;
    if (detail.description) product.description = detail.description;
    if (detail.images.length) {
      const merged = [...new Set([...detail.images, ...(product.imageUrls || [])])];
      if (JSON.stringify(merged) !== JSON.stringify(product.imageUrls || [])) {
        product.imageUrls = merged;
        product.localImages = [];
        product.aiImages = [];
        product.status.images = 'pending';
        delete product.errors.images;
      }
    }
    // SEO copied the empty spec set; drop it so the SEO stage regenerates.
    if (product.seo) product.seo.specs = { ...product.specs };
    product.status.uploaded = 'pending';
    delete product.errors.uploaded;
    product.updatedAt = new Date().toISOString();
    repaired += 1;
    log.ok(`  repaired ${product.name.slice(0, 45)} (${Object.keys(product.specs).length} specs)`);
  }
  await store.save();

  const failed = broken.length - repaired;
  if (failed) log.warn(`  ${failed} product(s) still have no specifications`);
  log.ok(`repaired ${repaired} product(s); run Images, then Upload`);
  return { repaired, failed };
}

// ---------------- scrape a single product URL ----------------
export async function runScrapeSingle(url) {
  if (!url) throw new Error('provide a product URL');
  const rec = await scrapeSingle(url, { headful: config.indiamart.headful });
  if (!rec) throw new Error('no product extracted from that URL');
  return withStore((store) => {
    const { product, inserted } = store.upsert(rec, { refresh: true });
    log.ok(`${inserted ? 'added' : 'already had'}: ${product.name}`);
    return { added: inserted ? 1 : 0, product };
  });
}

// ---------------- delete products ----------------
export async function deleteProducts(ids = []) {
  return withStore((store) => {
    const n = store.remove(ids);
    log.ok(`deleted ${n} product(s)`);
    return { deleted: n };
  });
}

// ---------------- import existing JSON ----------------
export async function runImport(file) {
  const rows = JSON.parse(await fsp.readFile(file, 'utf8'));
  return withStore((store) => {
    let added = 0;
    for (const row of rows) {
      const fields = {
        name: row.name,
        price: row.price_value ?? row.price ?? '',
        unit: row.price_unit ?? row.unit ?? 'Piece',
        description: row.description || row.desc || '',
        specs: row.specs || {},
        compound: row.compound || '',
        imageUrls: [row.primary_image, ...(row.images || [])].filter(Boolean),
        sourceId: String(row.id ?? row.slug ?? row.name),
        sourceUrl: row.source_url || '',
      };
      const { inserted } = store.upsert(fields);
      if (inserted) added++;
    }
    log.ok(`imported ${rows.length} rows, ${added} new (total ${store.all().length})`);
    return { imported: rows.length, added };
  });
}

/**
 * Did this failure come from the Chromium session dying rather than from the
 * product? Messages recorded on a real run whose browser window went away:
 *   "page.goto: Target page, context or browser has been closed"
 *   "Gallery upload failed (3 photos): page.evaluate: Target page, context or
 *    browser has been closed"
 * Every product attempted after that point failed the same way in milliseconds.
 */
export function browserSessionGone(error) {
  const message = String(error?.message || error || '');
  return (
    /(page|context|browser)\s+has been closed/i.test(message) ||
    /Target (page )?(closed|crashed)/i.test(message) ||
    /Browser (has been )?closed/i.test(message) ||
    /Protocol error.*(Target closed|Session closed)/i.test(message)
  );
}

// ---------------- images ----------------
/** A stage marked done that did not actually capture every source photo. */
function photosIncomplete(product) {
  const wanted = (product.imageUrls || []).filter((url) => /^https?:/.test(url)).length;
  return wanted > 0 && (product.localImages || []).length < wanted;
}

export async function runImages({ limit, ids } = {}) {
  return withStore(async (store) => {
    // "done" is only true when every source photo is on disk. A run that was
    // marked done with 1 of 3 photos is unfinished work, not a finished stage,
    // and used to stay that way for good because this filter skipped it.
    let todo = store
      .all()
      .filter((p) => !['done', 'skipped'].includes(p.status.images) || photosIncomplete(p));
    if (ids?.length) todo = todo.filter((p) => ids.includes(p.id));
    if (limit) todo = todo.slice(0, limit);
    log.step(`images: ${todo.length} product(s)`);
    if (!todo.length) log.warn('  nothing to do — extract/scrape products first.');
    const limiter = pLimit(config.concurrency);
    await Promise.all(
      todo.map((p) =>
        limiter(async () => {
          try {
            const wanted = (p.imageUrls || []).filter((url) => /^https?:/.test(url)).length;
            p.localImages = await downloadImages(p);
            if (!p.localImages.length) throw new Error('no images downloaded');
            // A partial gallery used to be accepted and marked done, so a
            // product kept one photo out of three for good. Require every
            // source photo, and say which count fell short.
            if (p.localImages.length < wanted) {
              throw new Error(`only ${p.localImages.length} of ${wanted} source photos downloaded`);
            }
            let usedAi = false;
            if (config.image.ai) {
              // AI is optional enhancement. Keep all processed real photos when
              // the configured provider/model is unavailable instead of marking
              // a successful multi-image download as failed.
              try {
                const ai = await regenerateImage(p);
                p.aiImages = [ai];
                usedAi = true;
              } catch (aiError) {
                p.aiImages = [];
                log.warn(`  AI image unavailable — using ${p.localImages.length} real photo(s): ${aiError.message}`);
              }
            } else {
              p.aiImages = [];
            }
            store.markStage(p, 'images', 'done');
            log.ok(
              `  images ✓ ${p.name.slice(0, 45)} ` +
                `(${p.localImages.length}/${wanted} photo${wanted === 1 ? '' : 's'}${usedAi ? ' + AI primary' : ''})`,
            );
          } catch (e) {
            store.markStage(p, 'images', 'error', e);
            log.error(`  images ✗ ${p.name.slice(0, 45)}: ${e.message}`);
          }
          await store.save();
        }),
      ),
    );

    // Close the stage with the counts, so a short run is obvious.
    const succeeded = todo.filter((p) => p.status.images === 'done');
    const failed = todo.filter((p) => p.status.images === 'error');
    const photos = succeeded.reduce((sum, p) => sum + p.localImages.length, 0);
    log.ok(
      `images complete: ${succeeded.length}/${todo.length} product(s), ${photos} photo(s) downloaded`,
    );
    if (failed.length) {
      log.warn(`  ${failed.length} product(s) failed:`);
      failed.forEach((p) => log.warn(`    ${p.name.slice(0, 48)} — ${p.errors.images}`));
    }
  });
}

// ---------------- seo ----------------
export async function runSeo({ limit, ids } = {}) {
  return withStore(async (store) => {
    // SEO is text-only; it does NOT need the image stage first.
    let todo = store.all().filter((p) => !['done', 'skipped'].includes(p.status.seo));
    if (ids?.length) todo = todo.filter((p) => ids.includes(p.id));
    if (limit) todo = todo.slice(0, limit);
    log.step(`seo: ${todo.length} product(s)`);
    if (!todo.length) log.warn('  nothing to do — extract/scrape products first.');
    const limiter = pLimit(config.concurrency);
    await Promise.all(
      todo.map((p) =>
        limiter(async () => {
          try {
            p.seo = await generateSeo(p);
            store.markStage(p, 'seo', 'done');
            log.ok(`  seo ✓ ${p.seo.name.slice(0, 45)}`);
          } catch (e) {
            store.markStage(p, 'seo', 'error', e);
            log.error(`  seo ✗ ${p.name.slice(0, 45)}: ${e.message}`);
          }
          await store.save();
        }),
      ),
    );
  });
}

/**
 * Reasons a product is not ready to be published.
 *
 * A half-built listing goes live reading "6 missing" on IndiaMART and cannot be
 * fixed from the card, so completeness is checked BEFORE the browser opens
 * rather than discovered afterwards. Products that fail are marked with the
 * exact reason and left for the next run once their data is repaired.
 */
export function uploadBlockers(product) {
  const blockers = [];
  const specCount =
    Object.keys(product.specs || {}).length || Object.keys(product.seo?.specs || {}).length;
  if (!specCount) blockers.push('no specifications');
  if (!productImageFiles(product).length) blockers.push('no images');
  if (!(product.seo?.description || product.description || '').trim()) {
    blockers.push('no description');
  }
  return blockers;
}

/**
 * Stored products that would resolve to the same live listing.
 *
 * The uploader finds a listing by name, so two products sharing a name fight
 * over one item: the second overwrites what the first just published. Seller
 * catalogues do repeat names, so this is caught before anything is uploaded
 * rather than discovered as a silently overwritten listing afterwards.
 *
 * @returns Map of product -> reason, for the products that clash.
 */
export function duplicateListingNames(products) {
  const byKey = new Map();
  for (const product of products) {
    const keys = new Set([product.seo?.name, product.name].filter(Boolean).map(slugify));
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(product);
    }
  }
  const clashes = new Map();
  for (const [key, group] of byKey) {
    if (group.size < 2) continue;
    for (const product of group) {
      const others = [...group].filter((other) => other !== product).map((other) => other.id);
      clashes.set(product, `same listing name "${key}" as ${others.join(', ')}`);
    }
  }
  return clashes;
}

/**
 * Classify products the account already carries, without ever adding a
 * duplicate. Matching is by normalised token set, so the same product written
 * differently ("Vidalista 20 Mg …" / "20mg Vidalista …", "Tablet" / "Tablets",
 * a leading "Generic") is recognised while 60mg and 80mg stay distinct.
 *
 * Names that match except for which active ingredient they quote are only
 * REPORTED: one of the two is mislabelled at the source and choosing between
 * them is not the uploader's call.
 */
function applyExistingSkip(store, todo, existingState, { repairActive = false } = {}) {
  const kept = [];
  let skipped = 0;
  const active = existingState?.active || new Set();
  const inactive = existingState?.inactive || new Set();
  const activeKeys = new Set([...active].map(listingKey));
  const inactiveKeys = new Set([...inactive].map(listingKey));
  const nearMatches = [];

  for (const p of todo) {
    const names = [p.seo?.name, p.name].filter(Boolean);
    const candidates = names.map(listingKey);
    const activeMatch = candidates.some((candidate) => activeKeys.has(candidate));
    const inactiveMatch = candidates.some((candidate) => inactiveKeys.has(candidate));
    if (activeMatch && repairActive) {
      kept.push(p);
      log.warn(`  existing Active product will be reconciled: ${(p.seo?.name || p.name).slice(0, 55)}`);
    } else if (activeMatch || inactiveMatch) {
      store.markStage(p, 'uploaded', 'skipped');
      skipped++;
      log.warn(
        `  already ${activeMatch ? 'Active' : 'Inactive/Deactivated'}, skipping: ` +
          `${(p.seo?.name || p.name).slice(0, 55)}`,
      );
    } else {
      const live = [...active, ...inactive].find((existing) =>
        names.some((name) => isNearMatch(name, existing)),
      );
      if (live) nearMatches.push(`${(p.seo?.name || p.name).slice(0, 50)}  ~  ${live.slice(0, 50)}`);
      kept.push(p);
    }
  }
  if (skipped) log.ok(`  skipped ${skipped} product(s) already in your account`);
  if (nearMatches.length) {
    log.warn(`  ${nearMatches.length} product(s) look like an existing listing with a different ingredient name:`);
    nearMatches.forEach((line) => log.warn(`    ${line}`));
    log.warn('    these were NOT skipped — check them before or after upload');
  }
  return kept;
}

// ---------------- upload (sequential — one browser) ----------------
export async function runUpload({
  limit,
  dryRun = false,
  ids,
  group = '',
  skipExisting = config.indiamart.skipExisting,
} = {}) {
  return withStore(async (store) => {
    // A product is uploadable as soon as it exists — the uploader falls back to
    // the raw scraped name/description/specs/image when AI stages haven't run.
    let todo = store.all().filter((p) => !['done', 'skipped'].includes(p.status.uploaded));
    if (ids?.length) todo = todo.filter((p) => ids.includes(p.id));
    if (limit) todo = todo.slice(0, limit);
    log.step(`upload: ${todo.length} product(s)${dryRun ? ' (dry-run)' : ''}`);
    if (!todo.length) {
      log.warn('  nothing to upload — extract/scrape some products first (or they are all uploaded/skipped).');
      return;
    }
    // Verify completeness before opening the browser, so an incomplete product
    // is never published and the reason is recorded against it.
    const incomplete = [];
    const clashes = duplicateListingNames(todo);
    todo = todo.filter((p) => {
      const blockers = uploadBlockers(p);
      const clash = clashes.get(p);
      if (clash) blockers.push(clash);
      if (!blockers.length) return true;
      store.markStage(p, 'uploaded', 'error', `not uploaded — ${blockers.join(', ')}`);
      incomplete.push(`${(p.seo?.name || p.name).slice(0, 45)}: ${blockers.join(', ')}`);
      return false;
    });
    if (incomplete.length) {
      log.error(`  ${incomplete.length} product(s) are not ready and were NOT uploaded:`);
      incomplete.forEach((line) => log.warn(`    ${line}`));
      await store.save();
    }
    if (!todo.length) {
      log.warn('  nothing left to upload — fix the products listed above and run again.');
      return;
    }

    const up = new Uploader();
    await up.open();
    try {
      if (skipExisting) {
        log.step('  checking account for already-live products…');
        const existingState = await up.fetchExistingState();
        todo = applyExistingSkip(store, todo, existingState, { repairActive: true });
        await store.save();
        if (!todo.length) return;
      }
      let aborted = null;
      for (const p of todo) {
        try {
          log.step(`  uploading: ${(p.seo?.name || p.name).slice(0, 55)}`);
          const r = await up.addProduct(p, { dryRun });
          if (dryRun) continue;
          if (r.ok) {
            store.markStage(p, 'uploaded', 'done');
            // Name the exact IndiaMART item and whether it was created or
            // reconciled, so a run can be checked against the account.
            log.ok(
              `  ${r.created ? 'created new listing' : 'reconciled existing listing'} ✓ ` +
                `item ${r.itemId} (Active ${r.before} -> ${r.after}, ` +
                `${r.photoCount} photo(s), PDF ${r.pdfName})`,
            );
            const wantedGroup = String(p.group || group || '').trim();
            if (wantedGroup) {
              try {
                const applied = await up.applyGroup(p, wantedGroup);
                if (applied.changed) {
                  log.ok(`  group set: ${applied.group}${applied.created ? ' (new group)' : ''}`);
                }
              } catch (groupError) {
                // The listing is published and correct; only grouping failed.
                log.warn(`  group not set: ${groupError.message}`);
              }
            }
          } else {
            store.markStage(p, 'uploaded', 'error', 'could not confirm listing');
          }
        } catch (e) {
          // A dead browser is not a fault of the product. Without this the run
          // raced through every remaining item in seconds, stamping each one
          // "error" for a session that had already gone — 29 products in one
          // observed run. Stop instead, and leave them pending for a re-run.
          if (browserSessionGone(e)) {
            store.markStage(p, 'uploaded', 'pending');
            await store.save();
            aborted = e;
            break;
          }
          store.markStage(p, 'uploaded', 'error', e);
          log.error(`  upload ✗ ${p.name.slice(0, 45)}: ${e.message}`);
        }
        await store.save();
      }

      if (aborted) {
        const remaining = todo.filter((p) => !['done', 'skipped', 'error'].includes(p.status.uploaded));
        log.error(
          `  upload stopped — the IndiaMART browser session ended (${aborted.message.split('\n')[0]}).`,
        );
        log.warn(
          `  ${remaining.length} product(s) were left pending and were NOT marked failed; ` +
            'run Upload again to continue where this stopped.',
        );
      }

      // Close the run with the counts, naming every listing that was touched,
      // so what was attempted and what actually published can be compared
      // against the account without reading back through the log.
      if (!dryRun) {
        const published = todo.filter((p) => p.status.uploaded === 'done');
        const failed = todo.filter((p) => p.status.uploaded === 'error');
        log.ok(`upload complete: ${published.length}/${todo.length} product(s) published`);
        published.forEach((p) => log.info(`    ✓ ${(p.seo?.name || p.name).slice(0, 55)}`));
        if (failed.length) {
          log.warn(`  ${failed.length} product(s) failed:`);
          failed.forEach((p) =>
            log.warn(`    ✗ ${(p.seo?.name || p.name).slice(0, 45)} — ${String(p.errors.uploaded).split('\n')[0].slice(0, 70)}`),
          );
        }
      }
    } finally {
      await up.close();
    }
  });
}

// ---------------- specifications-only repair ----------------
/** Update specifications on one exact existing live listing without re-uploading media. */
export async function reuploadSpecs(id) {
  return withStore(async (store) => {
    const product = store.get(id);
    if (!product) throw new Error(`product ${id} not found`);

    log.step(`specs re-upload: ${(product.seo?.name || product.name).slice(0, 55)}`);
    const up = new Uploader();
    await up.open();
    try {
      const result = await up.reuploadSpecs(product);
      store.markStage(product, 'uploaded', 'done');
      log.ok(`  specs re-uploaded ✓ ${result.name} (IndiaMART item ${result.itemId})`);
      return result;
    } finally {
      await up.close();
    }
  });
}

// ---------------- description-only repair ----------------
/** Update the description on one exact existing live listing without re-uploading media. */
export async function reuploadDescription(id) {
  return withStore(async (store) => {
    const product = store.get(id);
    if (!product) throw new Error(`product ${id} not found`);

    const description = product.seo?.description || product.description || '';
    if (!description.trim()) throw new Error('product description is empty');

    log.step(`description re-upload: ${(product.seo?.name || product.name).slice(0, 55)}`);
    const up = new Uploader();
    await up.open();
    try {
      const result = await up.reuploadDescription(product);
      store.markStage(product, 'uploaded', 'done');
      log.ok(
        `  description re-uploaded ✓ ${result.name} ` +
          `(IndiaMART item ${result.itemId}, ${result.descriptionCharacters} characters)`,
      );
      return result;
    } finally {
      await up.close();
    }
  });
}

// ---------------- full run ----------------
export async function runAll(opts = {}) {
  if (config.scrape.urls.length) await runScrape(opts);
  await runImages(opts);
  await runSeo(opts);
  await runUpload(opts);
}

export async function status() {
  const store = await new Store().load();
  return { counts: store.counts(), products: store.all() };
}

/** Just detect & mark already-live products as skipped (no uploading). */
export async function skipLive() {
  return withStore(async (store) => {
    const todo = store.all().filter((p) => !['done', 'skipped'].includes(p.status.uploaded));
    if (!todo.length) return { skipped: 0 };
    const up = new Uploader();
    await up.open();
    try {
      const existingState = await up.fetchExistingState();
      const kept = applyExistingSkip(store, todo, existingState);
      return { skipped: todo.length - kept.length };
    } finally {
      await up.close();
    }
  });
}

/** Save hand-edited SEO for one product (from the web UI). */
export async function updateSeo(id, seo) {
  return withStore((store) => {
    const p = store.get(id);
    if (!p) throw new Error(`product ${id} not found`);
    if (seo.specs && typeof seo.specs === 'object' && !Array.isArray(seo.specs)) {
      // Specs entered in the detail editor are explicit user-supplied source
      // data, so persist them as the uploader's authoritative spec record —
      // minus any seller contact row pasted in from the source listing.
      seo = { ...seo, specs: sanitizeSpecs(seo.specs) };
      p.specs = { ...seo.specs };
    }
    p.seo = { ...(p.seo || {}), ...seo };
    store.markStage(p, 'seo', 'done');
    return p;
  });
}

/** Reset a stage (and everything after it) to pending so it can be re-run. */
export async function resetStage(id, stage) {
  const order = ['images', 'seo', 'uploaded'];
  return withStore((store) => {
    const p = store.get(id);
    if (!p) throw new Error(`product ${id} not found`);
    const from = order.indexOf(stage);
    for (let i = Math.max(from, 0); i < order.length; i++) p.status[order[i]] = 'pending';
    p.updatedAt = new Date().toISOString();
    return p;
  });
}
