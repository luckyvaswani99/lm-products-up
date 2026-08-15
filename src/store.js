import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';
import { sanitizeSpecs, stripSellerSpecs } from './specSanitizer.js';

/**
 * Simple JSON-file product store. Each product moves through pipeline stages:
 *   scraped -> images -> seo -> uploaded
 * `status.<stage>` is one of: 'pending' | 'done' | 'error' | 'skipped'.
 */

const STAGES = ['scraped', 'images', 'seo', 'uploaded'];

function slugify(s = '') {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 90);
}

export function newProduct(fields = {}) {
  const name = fields.name || '';
  return {
    id: fields.id || slugify(`${name}-${fields.sourceId || Date.now()}`),
    sourceUrl: fields.sourceUrl || '',
    sourceId: fields.sourceId || '',
    // raw scraped fields
    name,
    price: fields.price ?? '',
    unit: fields.unit || '',
    description: fields.description || '',
    specs: sanitizeSpecs(fields.specs),
    imageUrls: fields.imageUrls || [],
    // derived
    compound: fields.compound || '',
    category: fields.category || '',
    // pipeline artifacts
    localImages: [],
    aiImages: [],
    seo: null, // { name, description, metaTitle, metaDescription, keywords, specs }
    // per-stage status
    status: { scraped: 'done', images: 'pending', seo: 'pending', uploaded: 'pending' },
    errors: {},
    updatedAt: new Date().toISOString(),
  };
}

export class Store {
  constructor(file = config.storeFile) {
    this.file = file;
    this.products = [];
    this._byId = new Map();
  }

  async load() {
    if (fs.existsSync(this.file)) {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.products = raw.trim() ? JSON.parse(raw) : [];
    } else {
      this.products = [];
    }
    // Records captured before seller rows were filtered still carry the other
    // seller's contact card. Drop it on load so it can never be uploaded.
    const removed = this.products.reduce((total, product) => total + stripSellerSpecs(product), 0);
    if (removed) log.warn(`removed ${removed} seller contact/GST row(s) from stored specs`);
    this._reindex();
    return this;
  }

  _reindex() {
    this._byId = new Map(this.products.map((p) => [p.id, p]));
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.products, null, 2));
  }

  get(id) {
    return this._byId.get(id);
  }

  all() {
    return this.products;
  }

  /**
   * Insert a new product or optionally refresh raw scraped fields in place.
   * Derived SEO/upload state is preserved; changed gallery URLs invalidate only
   * downloaded/AI images so a re-scrape can repair an old one-image record.
   */
  upsert(fields, { refresh = false } = {}) {
    const incoming = newProduct(fields);
    const existing = this._byId.get(incoming.id);
    if (!existing) {
      this.products.push(incoming);
      this._byId.set(incoming.id, incoming);
      return { product: incoming, inserted: true, refreshed: false };
    }
    if (!refresh) return { product: existing, inserted: false, refreshed: false };

    const galleryChanged = JSON.stringify(existing.imageUrls || []) !== JSON.stringify(incoming.imageUrls || []);
    for (const key of [
      'sourceUrl',
      'sourceId',
      'name',
      'price',
      'unit',
      'description',
      'specs',
      'imageUrls',
      'compound',
      'category',
    ]) {
      existing[key] = incoming[key];
    }
    existing.status = existing.status || { ...incoming.status };
    existing.errors = existing.errors || {};
    existing.status.scraped = 'done';
    if (galleryChanged) {
      existing.localImages = [];
      existing.aiImages = [];
      existing.status.images = 'pending';
      delete existing.errors.images;
    }
    existing.updatedAt = new Date().toISOString();
    return { product: existing, inserted: false, refreshed: true };
  }

  /** Remove products by id. Returns count removed. */
  remove(ids = []) {
    const set = new Set(ids);
    const before = this.products.length;
    this.products = this.products.filter((p) => !set.has(p.id));
    this._reindex();
    return before - this.products.length;
  }

  markStage(product, stage, status, error) {
    if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
    product.status[stage] = status;
    if (error) product.errors[stage] = String(error?.message || error);
    else delete product.errors[stage];
    product.updatedAt = new Date().toISOString();
  }

  /** Products whose given stage is still pending (and prerequisites done). */
  pending(stage) {
    const idx = STAGES.indexOf(stage);
    const prereq = STAGES[idx - 1];
    return this.products.filter((p) => {
      if (p.status[stage] === 'done' || p.status[stage] === 'skipped') return false;
      if (prereq && p.status[prereq] !== 'done' && p.status[prereq] !== 'skipped') return false;
      return true;
    });
  }

  counts() {
    const c = {};
    for (const s of STAGES) {
      c[s] = { done: 0, pending: 0, error: 0, skipped: 0 };
      for (const p of this.products) c[s][p.status[s]] = (c[s][p.status[s]] || 0) + 1;
    }
    c.total = this.products.length;
    return c;
  }
}

export { STAGES, slugify };
