import fs from 'node:fs';

/**
 * Return the exact ordered gallery used for IndiaMART upload.
 * AI output replaces only its corresponding leading source image; every
 * remaining real source photo is retained in order.
 */
export function productImageFiles(product) {
  const localImages = (product.localImages || []).filter((file) => file && fs.existsSync(file));
  const aiImages = (product.aiImages || []).filter((file) => file && fs.existsSync(file));
  const candidates = aiImages.length
    ? [...aiImages, ...localImages.slice(Math.min(aiImages.length, localImages.length))]
    : localImages;
  return [...new Set(candidates)];
}
