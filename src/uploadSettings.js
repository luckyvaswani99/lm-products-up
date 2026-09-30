import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Choices that change how an upload run behaves.
 *
 * Kept on disk rather than in the page, because a toggle that lives only in the
 * browser is lost on the next refresh — the duplicate lookup switched itself
 * back on that way, and a run then did the very thing it had been told not to.
 *
 * findDuplicates        search the account for an existing listing of the same
 *                       name before adding. Off, products go straight to Add
 *                       Product; everything checked after Finish is unchanged.
 * brochurePageInGallery add the rendered PDF page to the product's photos.
 *                       The PDF itself is attached either way — this is only
 *                       the extra gallery image, and it costs ~17s a product.
 */
const settingsPath = path.join(config.dataDir, 'upload-settings.json');

const DEFAULTS = { findDuplicates: true, brochurePageInGallery: true };

export function loadUploadSettings() {
  if (fs.existsSync(settingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return {
        findDuplicates:
          typeof data.findDuplicates === 'boolean' ? data.findDuplicates : DEFAULTS.findDuplicates,
        brochurePageInGallery:
          typeof data.brochurePageInGallery === 'boolean'
            ? data.brochurePageInGallery
            : DEFAULTS.brochurePageInGallery,
      };
    } catch {
      // fall through to the defaults
    }
  }
  return { ...DEFAULTS };
}

export function saveUploadSettings(input = {}) {
  const current = loadUploadSettings();
  const next = {
    findDuplicates:
      typeof input.findDuplicates === 'boolean' ? input.findDuplicates : current.findDuplicates,
    brochurePageInGallery:
      typeof input.brochurePageInGallery === 'boolean'
        ? input.brochurePageInGallery
        : current.brochurePageInGallery,
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, settingsPath);
  return next;
}
