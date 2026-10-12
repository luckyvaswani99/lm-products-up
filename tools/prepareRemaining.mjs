/**
 * Get the products still not live ready to upload.
 *
 *  - products whose card has no product page (source link is the category page
 *    plus "#id") carry only what the card shows. Per the user's decision of
 *    2026-10-12 their Strength comes from the product name, and their description
 *    is a plain statement of facts that are all known: the name, the price and the
 *    supplier on this account. Nothing else is stated.
 *  - products that DO have a page but were never read are read now.
 *  - one product per duplicated listing name: the seller lists some products twice
 *    and the uploader finds a listing by name, so a second copy would overwrite
 *    the first.
 */
import { Store } from '../src/store.js';
import { config } from '../src/config.js';
import { log } from '../src/logger.js';
import { readProductPages } from '../src/scraper/catalogScraper.js';
import { duplicateListingNames } from '../src/pipeline.js';
import { strengthInName } from '../src/uploader/specFiller.js';

const store = await new Store().load();
const open = () => store.all().filter((p) => !['done', 'skipped'].includes(p.status.uploaded));

// 1. products with a real page that were not read
const unread = open().filter(
  (p) => !p.sourceUrl.includes('#') && !(Object.keys(p.specs || {}).length && String(p.description || '').trim()),
);
if (unread.length) {
  const found = await readProductPages(unread.map((p) => p.sourceUrl));
  for (const product of unread) {
    const detail = found.get(product.sourceUrl);
    if (!detail) continue;
    if (detail.description) product.description = detail.description;
    if (Object.keys(detail.specs || {}).length) product.specs = { ...product.specs, ...detail.specs };
    product.status.uploaded = 'pending';
    product.errors.uploaded = '';
    log.ok(`  read ${product.name}`);
  }
}

// 2. products with no page: facts from the name, price and supplier only
const { name: supplier, city, state } = config.supplier;
const FORMS = [
  ['tablet', 'Tablet'], ['capsule', 'Capsule'], ['injection', 'Injection'], ['syrup', 'Syrup'],
  ['cream', 'Cream'], ['gel', 'Gel'], ['ointment', 'Ointment'], ['lotion', 'Lotion'],
  ['shampoo', 'Shampoo'], ['spray', 'Spray'], ['drops', 'Drops'], ['powder', 'Powder'],
  ['solution', 'Solution'], ['suspension', 'Suspension'],
];
const formInName = (name) => {
  const words = String(name || '').toLowerCase().match(/[a-z]+/g) || [];
  const hits = FORMS.filter(([key]) => words.some((word) => word === key || word === `${key}s`));
  return hits.length === 1 ? hits[0][1] : '';
};

for (const product of open().filter((p) => p.sourceUrl.includes('#') && !Object.keys(p.specs || {}).length)) {
  const specs = {};
  const strength = strengthInName(product.name);
  if (strength) specs.Strength = strength;
  const form = formInName(product.name);
  if (form) specs.Form = form;
  if (!Object.keys(specs).length) {
    log.warn(`  ${product.name}: the name states no strength or form — left alone`);
    continue;
  }
  product.specs = specs;
  const price = product.price ? `Price: Rs ${product.price} per ${product.unit || 'Piece'}. ` : '';
  product.description =
    `${product.name}. ${price}Supplied by ${supplier}, ${[city, state].filter(Boolean).join(', ')}.`;
  product.detailsFromName = true;
  store.markStage(product, 'uploaded', 'pending');
  log.ok(`  from name: ${product.name} -> ${JSON.stringify(specs)}`);
}

// 3. keep one product per duplicated listing name
const clashes = duplicateListingNames(open());
const seen = new Map();
for (const [product, reason] of clashes) {
  const key = reason.match(/"(.*?)"/)[1];
  if (!seen.has(key)) {
    seen.set(key, product);
    continue;
  }
  store.markStage(product, 'uploaded', 'skipped', `same product listed twice by the seller as "${seen.get(key).name}"`);
  log.info(`  skipped duplicate: ${product.name}`);
}
await store.save();
const left = open();
log.ok(`${left.length} product(s) ready to try; ${store.all().filter((p) => p.status.uploaded === 'skipped').length} skipped as duplicates`);
