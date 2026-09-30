import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Whether the SEO stage rewrites listings with DeepSeek.
 *
 * Turned off, nothing is generated and nothing is paid for: the product's own
 * scraped name, description and specifications are what gets uploaded. The AI
 * path is untouched and comes back the moment this is switched on again.
 */
const settingsPath = path.join(config.dataDir, 'seo-settings.json');

export function loadSeoSettings() {
  if (fs.existsSync(settingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (typeof data.ai === 'boolean') return { ai: data.ai };
    } catch {
      // fall through to the default
    }
  }
  return { ai: true };
}

export function saveSeoSettings(input = {}) {
  const next = { ai: typeof input.ai === 'boolean' ? input.ai : loadSeoSettings().ai };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, settingsPath);
  return next;
}
