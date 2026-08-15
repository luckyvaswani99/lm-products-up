/**
 * Identity of a listing by name, for deciding "is this product already live?".
 *
 * Exact-name matching misses products the account already carries, because the
 * same product is written differently in different places — "Vidalista 20 Mg
 * Tadalafil Tablets" vs "20mg Vidalista Tadalafil Tablets", "Tablet" vs
 * "Tablets", a leading "Generic". All of those are the same listing.
 *
 * The key is a normalised token SET, so word order, plural forms and packaging
 * nouns stop mattering, while the parts that identify the product — strength
 * and brand — must still match exactly. 60mg and 80mg never collapse together.
 */

/** Words that never distinguish one product from another. */
const NOISE = new Set([
  'tablet',
  'capsule',
  'injection',
  'vial',
  'strip',
  'pack',
  'box',
  'bottle',
  'generic',
  'usp',
  'ip',
  'bp',
  'and',
  'the',
  'of',
  'for',
  'with',
  'mg',
  'ml',
  'mcg',
  'gm',
  'g',
]);

/** Normalised token set for a product name, as a stable comparable string. */
export function listingKey(name) {
  const text = String(name || '')
    .toLowerCase()
    // "20 mg" and "20 Mg" become one token so the strength cannot drift apart
    .replace(/(\d)\s*(mg|mcg|ml|gm|g)\b/g, '$1$2')
    .replace(/[^a-z0-9.]+/g, ' ');

  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/s$/, ''))
    .filter((token) => token && !NOISE.has(token));

  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Identity of the name a product will actually be published under.
 *
 * Unlike listingKey this keeps every word, because here the question is "would
 * these two of ours land on the same listing?" rather than "is this the same
 * product the account already has". Dropping packaging nouns is wrong for that:
 * "Dutaheal Dutasteride 0.5 mg Tablet" (₹350, 20x10 tablets) and "… 0.5 mg
 * Capsules" (₹300, 30 capsules) are two products, and treating them as one
 * blocked both. Only case, punctuation, plurals and "20 mg" spacing are
 * normalised, so pure word-order duplicates are still caught.
 */
export function uploadNameKey(name) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/(\d)\s*(mg|mcg|ml|gm|g)\b/g, '$1$2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/s$/, ''))
    .filter(Boolean);

  return [...new Set(tokens)].sort().join(' ');
}

/**
 * Active ingredients seen on this account's listings. Used only to recognise
 * that two names differ by which ingredient they quote — never to infer what a
 * product contains.
 */
const INGREDIENTS = new Set([
  'tadalafil',
  'sildenafil',
  'vardenafil',
  'dapoxetine',
  'carisoprodol',
  'pregabalin',
  'gabapentin',
  'methylprednisolone',
  'methocarbamol',
  'cyclobenzaprine',
  'ketorolac',
  'diclofenac',
  'naproxen',
  'testosterone',
  'trenbolone',
  'drostanolone',
  'methenolone',
  'minoxidil',
  'isotretinoin',
]);

/**
 * Same brand and same strength, but the names quote a different active
 * ingredient — e.g. "80mg Vidalista Black Sildenafil Tablets" against the live
 * "80mg Vidalista Black Tadalafil Tablets". One of the two is mislabelled at
 * the source, so this is reported for a human decision and never skipped
 * automatically.
 *
 * A different BRAND is not a near match: "20Mg Tadalee Tadalafil" and
 * "Vidalista 20 Mg Tadalafil" are separate products and must both exist.
 */
export function isNearMatch(a, b) {
  const left = listingKey(a).split(' ').filter(Boolean);
  const right = listingKey(b).split(' ').filter(Boolean);
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ')) return false;
  if (left.length !== right.length) return false;

  const onlyInLeft = left.filter((token) => !right.includes(token));
  const onlyInRight = right.filter((token) => !left.includes(token));
  // Exactly one token differs on each side, and both are ingredient names —
  // so the brand and the strength are identical.
  return (
    onlyInLeft.length === 1 &&
    onlyInRight.length === 1 &&
    INGREDIENTS.has(onlyInLeft[0]) &&
    INGREDIENTS.has(onlyInRight[0])
  );
}
