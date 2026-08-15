/**
 * IndiaMART detail pages print the seller's own contact card into the same
 * tables as the product specification, so a plain table scrape also picks up
 * rows like "Contact Number", "Verified GST Number" and "Address". Those
 * describe the *supplier*, not the product: they are wrong on our own listing
 * and are not ours to republish. Drop them at every boundary — scrape, store
 * and upload form — so no seller-identifying row can reach IndiaMART.
 */

/**
 * Supplier-profile rows. Matched anywhere in the key (not just as a prefix) so
 * "Verified GST Number" drops the same as a plain "GST" row.
 */
const SELLER_KEY = new RegExp(
  [
    'gst',
    'contact\\s*(number|no\\b|person|details)',
    'mobile|phone|telephone|fax',
    'e-?mail',
    'address',
    'website',
    'import\\s*export|\\biec\\b',
    '\\bcin\\b|udyam|msme|trustseal',
    'annual\\s*turnover',
    'employees',
    'legal\\s*status',
    'nature\\s*of\\s*business',
    'business\\s*type',
    'payment\\s*terms',
    'banker',
    'member\\s*since',
    'year\\s*of\\s*establishment',
    'indiamart\\s*member',
  ].join('|'),
  'i',
);

/**
 * Contact details identify themselves by shape, so a row renamed by the seller
 * is still caught. Anchored to the whole value so product codes, pack sizes and
 * strengths are never mistaken for contact data.
 */
const SELLER_VALUE = [
  // Indian mobile number (they start 6-9), with or without a country code.
  /^(?:\+\d{1,3}[-\s]?)?[6-9]\d{9}$/,
  // GSTIN, including the masked form IndiaMART shows: "27**********1ZZ".
  /^\d{2}[\dA-Z*]{13}$/i,
  /^[\w.+-]+@[\w-]+\.[\w.]+$/,
];

/** True when a spec row describes the seller rather than the product. */
export function isSellerField(key, value) {
  if (SELLER_KEY.test(String(key || ''))) return true;
  return SELLER_VALUE.some((pattern) => pattern.test(String(value ?? '').trim()));
}

/** Return only the rows that describe the product itself. */
export function sanitizeSpecs(specs) {
  if (!specs || typeof specs !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(specs)) {
    if (!isSellerField(key, value)) clean[key] = value;
  }
  return clean;
}

/**
 * Strip seller rows from a stored product in place, covering both the scraped
 * specs and the SEO copy of them. Returns the number of rows removed so a
 * caller can report exactly what was dropped instead of silently rewriting.
 */
export function stripSellerSpecs(product) {
  let removed = 0;
  for (const target of [product, product?.seo]) {
    if (!target?.specs || typeof target.specs !== 'object') continue;
    const before = Object.keys(target.specs).length;
    target.specs = sanitizeSpecs(target.specs);
    removed += before - Object.keys(target.specs).length;
  }
  return removed;
}
