import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const BACKGROUND_REMOVAL_MODEL = 'u2netp';
export const BACKGROUND_REMOVAL_THREADS = 2;
export const BACKGROUND_REMOVAL_CONCURRENCY = 1;

export const backgroundRemovalDir = path.join(config.dataDir, 'background-removal');
export const backgroundRemovalModelDir = path.join(backgroundRemovalDir, 'models');
export const backgroundRemovalModelPath = path.join(backgroundRemovalModelDir, `${BACKGROUND_REMOVAL_MODEL}.onnx`);
const settingsPath = path.join(backgroundRemovalDir, 'settings.json');
const APPLY_TO = new Set(['all', 'primary']);

export function defaultBackgroundRemovalSettings() {
  return {
    enabled: false,
    applyTo: 'all',
    model: BACKGROUND_REMOVAL_MODEL,
  };
}

function normalizeSettings(input = {}) {
  const merged = { ...defaultBackgroundRemovalSettings(), ...input };
  const applyTo = String(merged.applyTo || '');
  if (!APPLY_TO.has(applyTo)) throw new Error(`Invalid background-removal apply-to value: ${applyTo}`);
  if (String(merged.model) !== BACKGROUND_REMOVAL_MODEL) {
    throw new Error(`Only the lightweight ${BACKGROUND_REMOVAL_MODEL} model is supported`);
  }
  return {
    enabled: merged.enabled === true,
    applyTo,
    model: BACKGROUND_REMOVAL_MODEL,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

export function loadBackgroundRemovalSettings() {
  if (!fs.existsSync(settingsPath)) return defaultBackgroundRemovalSettings();
  return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
}

export function saveBackgroundRemovalSettings(input) {
  const settings = normalizeSettings(input);
  writeJson(settingsPath, settings);
  return settings;
}
