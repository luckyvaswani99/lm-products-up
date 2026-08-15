import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const settingsPath = path.join(config.dataDir, 'image-settings.json');

export function loadImageSettings() {
  if (fs.existsSync(settingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (typeof data.ai === 'boolean') {
        config.image.ai = data.ai;
      }
    } catch {
      // fallback to config.image.ai
    }
  }
  return {
    ai: config.image.ai,
    provider: config.image.provider,
  };
}

export function saveImageSettings(input = {}) {
  const current = loadImageSettings();
  const next = {
    ...current,
    ai: typeof input.ai === 'boolean' ? input.ai : current.ai,
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, settingsPath);
  config.image.ai = next.ai;
  return next;
}
