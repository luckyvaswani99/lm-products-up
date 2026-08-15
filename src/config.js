import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const bool = (v, def = false) =>
  v === undefined ? def : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, def) => (v === undefined || v === '' ? def : parseInt(v, 10));

export const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  imagesDir: path.join(ROOT, 'data', 'images'),
  aiImagesDir: path.join(ROOT, 'data', 'ai-images'),
  storeFile: path.join(ROOT, 'data', 'products.json'),

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },

  image: {
    provider: (process.env.IMAGE_PROVIDER || 'gemini').toLowerCase(),
    // Set IMAGE_AI=false to skip AI regeneration and just use the real
    // downloaded photo (handy when your image provider has no quota/billing).
    ai: bool(process.env.IMAGE_AI, true),
    watermark: {
      replaceAuthorizedSource: bool(process.env.REPLACE_AUTHORIZED_SOURCE_WATERMARK, false),
      authorizedSellerIds: (process.env.AUTHORIZED_IMAGE_SELLER_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      text: process.env.IMAGE_TEXT_WATERMARK || process.env.SUPPLIER_NAME || 'Om Shanti Medical',
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    },
    replicate: {
      token: process.env.REPLICATE_API_TOKEN || '',
      model: process.env.REPLICATE_IMAGE_MODEL || 'black-forest-labs/flux-kontext-pro',
    },
  },

  indiamart: {
    sessionDir: path.resolve(ROOT, process.env.INDIAMART_SESSION_DIR || '.session'),
    sellerUrl:
      process.env.INDIAMART_SELLER_URL ||
      'https://seller.indiamart.com/product/manageproducts/',
    headful: bool(process.env.HEADFUL, true),
    // Optional pre-scan that reads every Active + Inactive product in the
    // account and marks name matches as "skipped". Off by default: IndiaMART
    // rejects duplicate names itself, and the uploader already reconciles an
    // exact existing item in place, so the scan only costs a full paged crawl
    // of the account before every upload. Set SKIP_EXISTING=true to re-enable.
    skipExisting: bool(process.env.SKIP_EXISTING, false),
  },

  scrape: {
    urls: (process.env.SCRAPE_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    limit: int(process.env.SCRAPE_LIMIT, 0),
  },

  supplier: {
    name: process.env.SUPPLIER_NAME || 'Om Shanti Medical',
    city: process.env.SUPPLIER_CITY || 'Nagpur',
    state: process.env.SUPPLIER_STATE || 'Maharashtra',
  },

  concurrency: int(process.env.CONCURRENCY, 3),
};

/** Throw a friendly error if a required key is missing for a stage. */
export function requireKeys(keys) {
  const missing = keys.filter((k) => !k.value);
  if (missing.length) {
    throw new Error(
      `Missing config: ${missing.map((m) => m.name).join(', ')}. ` +
        `Set them in your .env file (see .env.example).`,
    );
  }
}
