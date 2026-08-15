import { chromium } from 'playwright';
import { log } from '../logger.js';
import { extractDetail, guessCompound, parsePrice } from './indiamartScraper.js';
import { readProductGalleryWithRetry } from './productGallery.js';
import { PagedReader } from './rateLimit.js';

/**
 * Bulk extraction for a seller's CATEGORY page on indiamart.com, e.g.
 * https://www.indiamart.com/kyvex-global/pain-killer-medicines.html
 *
 * This layout is separate from the listing/search and white-label storefront
 * markup the main scraper handles, so it lives in its own module and the
 * existing extraction paths are untouched.
 *
 * Every selector below was read off the live page, not assumed:
 *   li.cat-slider__card   one per product; its id is the IndiaMART product id
 *   .cat-slider__name     product name
 *   .cat-slider__price    "₹ 600/Pack"
 *   img                   gallery thumbnail, served at -125x125
 * The product-page links are NOT inside the cards — the card's own anchors are
 * in-page (`#<id>`) — so each card is joined to the `a[href*="proddetail"]`
 * link carrying the same id. On the page checked, 39 of 40 cards had one.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** True for a seller category page this module knows how to read. */
export async function isCatalogPage(page) {
  return (await page.locator('li.cat-slider__card').count()) > 0;
}

/** Read every product card rendered on a category page. */
export async function extractCatalogCards(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const fixSize = (src) => (src || '').replace(/-\d+x\d+(\.[a-z]+)(\?.*)?$/i, '-1000x1000$1');
    // Product-page links sit outside the cards; join them by the numeric id.
    const detailLinks = [...document.querySelectorAll('a[href*="proddetail"]')].map((a) => a.href);

    return [...document.querySelectorAll('li.cat-slider__card')]
      .map((card) => {
        const id = card.id || '';
        const image = card.querySelector('img');
        return {
          id,
          name: clean((card.querySelector('.cat-slider__name') || {}).textContent),
          priceText: clean((card.querySelector('.cat-slider__price') || {}).textContent),
          image: fixSize(image ? image.currentSrc || image.getAttribute('src') || '' : ''),
          detailUrl: id ? detailLinks.find((href) => href.includes(id)) || '' : '',
        };
      })
      .filter((card) => card.id && card.name);
  });
}

/** How many times a product page is read before its specs are given up on. */
const DETAIL_ATTEMPTS = 3;

/**
 * Read one product page, insisting on a specification table.
 *
 * extractDetail returns an EMPTY record both when the page genuinely has no
 * specs and when the read failed — a slow render or throttling during a long
 * bulk run looks identical to success with nothing on the page. Accepting that
 * silently is what put products live with no specifications, so an empty read
 * is retried and then reported instead of being treated as a result.
 *
 * @returns the detail record, or null when no specs could be read.
 */
async function readDetail(page, url, name, reader) {
  for (let attempt = 1; attempt <= DETAIL_ATTEMPTS; attempt += 1) {
    // Navigate through the reader so a rate limit is seen as a rate limit,
    // not mistaken for a page without specifications.
    const status = await reader.open(page, url);
    if (status && status >= 400) {
      log.warn(`    HTTP ${status} for ${name.slice(0, 40)}`);
      return null;
    }
    await page.waitForTimeout(1800);
    const found = await extractDetail(page, url, { navigate: false });
    if (Object.keys(found.specs).length) {
      // extractDetail reads photos from rendered <img> elements, which are
      // lazy-loaded and therefore incomplete. Take the gallery from the page's
      // own HTML instead: it lists every frame from the first paint.
      const gallery = await readProductGalleryWithRetry(page, url, { log });
      return { ...found, images: gallery.images.length ? gallery.images : found.images };
    }
    if (attempt < DETAIL_ATTEMPTS) {
      log.warn(`    no specifications read (attempt ${attempt}/${DETAIL_ATTEMPTS}) — retrying`);
      await page.waitForTimeout(2000 * attempt);
    }
  }
  log.error(`    no specifications could be read for ${name.slice(0, 45)} — left for review`);
  return null;
}

/**
 * Re-read product pages for records whose specifications are missing, using the
 * same insistence on a real specification table. Returns a Map of url -> detail
 * for the pages that yielded specs; urls that stayed empty are absent, never
 * filled in with a placeholder.
 */
export async function readProductPages(urls, { headful = false } = {}) {
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const found = new Map();
  const reader = new PagedReader();
  try {
    for (const [index, url] of urls.entries()) {
      log.info(`  re-reading ${index + 1}/${urls.length}: ${url.split('/').pop().slice(0, 50)}`);
      const detail = await readDetail(page, url, url, reader);
      if (detail) found.set(url, detail);
    }
  } catch (error) {
    if (!error.rateLimited) throw error;
    // Keep everything read so far; the caller saves it and the run resumes.
    log.error(error.message);
  } finally {
    await browser.close();
  }
  log.ok(`  recovered specifications for ${found.size}/${urls.length} product page(s)`);
  return found;
}

/**
 * Scrape one or more seller category pages.
 *
 * Cards give the name, price and thumbnail; the product page gives the full
 * specification table, description and gallery. A card without a product-page
 * link keeps only what the card actually showed — nothing is inferred to fill
 * the gap, and the shortfall is reported.
 *
 * @returns {Promise<object[]>} raw product records for the store
 */
export async function scrapeCatalog(urls, { limit = 0, detail = true, headful = false } = {}) {
  const browser = await chromium.launch({ headless: !headful });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const results = [];

  try {
    for (const url of urls) {
      log.step(`catalog: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      const cards = await extractCatalogCards(page);
      if (!cards.length) {
        log.warn('  no product cards found — this page is not a seller category page');
        continue;
      }
      const missingDetail = cards.filter((card) => !card.detailUrl).length;
      log.info(
        `  ${cards.length} product card(s); ${cards.length - missingDetail} link to a product page`,
      );
      if (missingDetail) {
        log.warn(`  ${missingDetail} card(s) have no product page link — specs cannot be read for them`);
      }

      for (const card of cards) {
        if (limit && results.length >= limit) break;
        const { price, unit } = parsePrice(card.priceText);
        results.push({
          name: card.name,
          price,
          unit: unit || 'Piece',
          description: '',
          specs: {},
          imageUrls: card.image ? [card.image] : [],
          sourceUrl: card.detailUrl || `${url}#${card.id}`,
          sourceId: card.id,
          compound: guessCompound(card.name),
          _detailUrl: card.detailUrl,
        });
      }
      if (limit && results.length >= limit) break;
    }

    if (detail) {
      const detailPage = await ctx.newPage();
      const reader = new PagedReader();
      const withDetail = results.filter((record) => record._detailUrl);
      let enriched = 0;
      let read = 0;
      for (const record of results) {
        if (!record._detailUrl) continue;
        read += 1;
        log.info(`  product page ${read}/${withDetail.length}: ${record.name.slice(0, 45)}`);
        const found = await readDetail(detailPage, record._detailUrl, record.name, reader);
        if (!found) {
          record._specsMissing = true;
          continue;
        }
        if (found.description) record.description = found.description;
        if (Object.keys(found.specs).length) record.specs = { ...record.specs, ...found.specs };
        if (found.moq) record.specs['Minimum Order Quantity'] = found.moq;
        if (found.images.length) {
          // The page gallery is the complete, ordered set (primary first), so it
          // REPLACES the single card thumbnail rather than being merged with it —
          // merging re-added the same frame under a second URL.
          record.imageUrls = found.images;
        }
        if (!record.price && found.priceText) {
          const parsed = parsePrice(found.priceText);
          record.price = parsed.price || record.price;
          if (parsed.unit) record.unit = parsed.unit;
        }
        if (!record.compound) {
          const composition =
            record.specs['Product Composition'] ||
            record.specs['Composition'] ||
            record.specs['Salt Composition'] ||
            record.specs['Salt'] ||
            '';
          record.compound = guessCompound(composition) || composition;
        }
        enriched += 1;
      }
      await detailPage.close();
      log.ok(`  read product pages for ${enriched}/${withDetail.length} product(s)`);
    }
  } catch (error) {
    if (!error.rateLimited) throw error;
    // Everything read before the block is real and is kept; re-running the
    // extract later fills in the rest instead of starting over.
    log.error(error.message);
  } finally {
    await browser.close();
  }

  // Report what was actually captured, per product, so a short extraction is
  // visible immediately instead of surfacing later as a bad listing.
  const withSpecs = results.filter((record) => Object.keys(record.specs).length).length;
  const withPhotos = results.filter((record) => record.imageUrls.length).length;
  const singlePhoto = results.filter((record) => record.imageUrls.length === 1);
  const totalPhotos = results.reduce((sum, record) => sum + record.imageUrls.length, 0);

  log.ok(
    `catalog complete: ${results.length} product(s) — ` +
      `${withSpecs} with specifications, ${withPhotos} with photos, ${totalPhotos} photos total`,
  );
  const incomplete = results.filter((record) => !Object.keys(record.specs).length || !record.imageUrls.length);
  if (incomplete.length) {
    log.warn(`  ${incomplete.length} product(s) are incomplete and will not be uploaded:`);
    incomplete.forEach((record) => {
      const missing = [
        Object.keys(record.specs).length ? '' : 'no specifications',
        record.imageUrls.length ? '' : 'no photos',
      ].filter(Boolean);
      log.warn(`    ${record.name.slice(0, 48)} — ${missing.join(', ')}`);
    });
  }
  if (singlePhoto.length) {
    log.warn(
      `  ${singlePhoto.length} product(s) have only one photo; check the source page if you expect more`,
    );
  }
  return results.map(({ _detailUrl, _specsMissing, ...record }) => record);
}
