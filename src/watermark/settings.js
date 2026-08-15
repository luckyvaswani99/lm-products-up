import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const WATERMARK_LOGO_MAX_BYTES = 5 * 1024 * 1024;

const watermarkDir = path.join(config.dataDir, 'watermark');
const settingsPath = path.join(watermarkDir, 'settings.json');
const logoMetadataPath = path.join(watermarkDir, 'logo.json');

const POSITIONS = new Set([
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);
const MODES = new Set(['text', 'image']);
const APPLY_TO = new Set(['all', 'primary']);
const PATTERNS = new Set(['single', 'tile']);
const FONT_FAMILIES = new Set(['Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New']);
const FONT_WEIGHTS = new Set([400, 500, 600, 700, 800]);

export function defaultWatermarkSettings() {
  return {
    enabled: false,
    mode: 'text',
    text: config.supplier.name || '',
    applyTo: 'all',
    pattern: 'single',
    position: 'bottom-right',
    opacity: 32,
    rotation: 0,
    marginPercent: 3,
    tileSpacingPercent: 18,
    textSizePercent: 4,
    textColor: '#ffffff',
    fontFamily: 'Arial',
    fontWeight: 700,
    backgroundEnabled: true,
    backgroundColor: '#000000',
    backgroundOpacity: 30,
    backgroundPaddingPercent: 1,
    imageWidthPercent: 18,
    quality: 92,
  };
}

export const WATERMARK_RECOMMENDATIONS = Object.freeze({
  note: 'Start with these values, then test one product before a batch upload.',
  position: 'Bottom right',
  opacity: '25–35%',
  margin: '3%',
  textSize: '4% of the shorter image side',
  imageWidth: '18% of image width',
  rotation: '0° for a single mark',
  pattern: 'Single',
  applyTo: 'All uploaded product photos',
  quality: '92%',
});

function numberInRange(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function oneOf(value, allowed, name) {
  if (!allowed.has(value)) throw new Error(`Invalid ${name}: ${value}`);
  return value;
}

function color(value, name) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) throw new Error(`${name} must be a six-digit hex color`);
  return normalized;
}

function normalizeSettings(input = {}) {
  const base = defaultWatermarkSettings();
  const merged = { ...base, ...input };
  const text = String(merged.text || '').trim();
  if (text.length > 120) throw new Error('Watermark text must be 120 characters or fewer');

  return {
    enabled: merged.enabled === true,
    mode: oneOf(String(merged.mode), MODES, 'watermark mode'),
    text,
    applyTo: oneOf(String(merged.applyTo), APPLY_TO, 'apply-to value'),
    pattern: oneOf(String(merged.pattern), PATTERNS, 'pattern'),
    position: oneOf(String(merged.position), POSITIONS, 'position'),
    opacity: numberInRange(merged.opacity, 'Opacity', 5, 100),
    rotation: numberInRange(merged.rotation, 'Rotation', -180, 180),
    marginPercent: numberInRange(merged.marginPercent, 'Margin', 0, 20),
    tileSpacingPercent: numberInRange(merged.tileSpacingPercent, 'Tile spacing', 2, 50),
    textSizePercent: numberInRange(merged.textSizePercent, 'Text size', 1, 20),
    textColor: color(merged.textColor, 'Text color'),
    fontFamily: oneOf(String(merged.fontFamily), FONT_FAMILIES, 'font family'),
    fontWeight: oneOf(Number(merged.fontWeight), FONT_WEIGHTS, 'font weight'),
    backgroundEnabled: merged.backgroundEnabled === true,
    backgroundColor: color(merged.backgroundColor, 'Background color'),
    backgroundOpacity: numberInRange(merged.backgroundOpacity, 'Background opacity', 0, 100),
    backgroundPaddingPercent: numberInRange(merged.backgroundPaddingPercent, 'Background padding', 0, 10),
    imageWidthPercent: numberInRange(merged.imageWidthPercent, 'Watermark image width', 3, 80),
    quality: numberInRange(merged.quality, 'JPEG quality', 70, 100),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function logoMetadata() {
  try {
    const metadata = readJson(logoMetadataPath);
    const fileName = path.basename(String(metadata.fileName || ''));
    const filePath = path.join(watermarkDir, fileName);
    if (!fileName || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    return {
      selected: true,
      name: metadata.originalName || fileName,
      mime: metadata.mime,
      size: stat.size,
      updatedAt: metadata.updatedAt || stat.mtime.toISOString(),
      filePath,
    };
  } catch {
    return null;
  }
}

export function loadWatermarkSettings() {
  if (!fs.existsSync(settingsPath)) return defaultWatermarkSettings();
  return normalizeSettings(readJson(settingsPath));
}

export function getWatermarkState() {
  const settings = loadWatermarkSettings();
  const logo = logoMetadata();
  return {
    settings,
    logo: logo
      ? { selected: true, name: logo.name, mime: logo.mime, size: logo.size, updatedAt: logo.updatedAt }
      : { selected: false, name: null, mime: null, size: 0, updatedAt: null },
    recommendations: WATERMARK_RECOMMENDATIONS,
  };
}

export function saveWatermarkSettings(input) {
  const settings = normalizeSettings(input);
  if (settings.enabled && settings.mode === 'text' && !settings.text) {
    throw new Error('Enter watermark text before enabling text watermarking');
  }
  if (settings.enabled && settings.mode === 'image' && !logoMetadata()) {
    throw new Error('Upload a watermark image before enabling image watermarking');
  }
  writeJson(settingsPath, settings);
  return getWatermarkState();
}

function detectLogo(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: '.webp', mime: 'image/webp' };
  }
  throw new Error('Watermark image must be a valid PNG, JPEG, or WebP file');
}

export function saveWatermarkLogo(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) throw new Error('Select a non-empty watermark image');
  if (buffer.length > WATERMARK_LOGO_MAX_BYTES) throw new Error('Watermark image must be 5 MB or smaller');
  const detected = detectLogo(buffer);
  const safeName = path.basename(String(originalName || `watermark${detected.extension}`)).slice(0, 180);
  fs.mkdirSync(watermarkDir, { recursive: true });
  for (const extension of ['.png', '.jpg', '.webp']) {
    fs.rmSync(path.join(watermarkDir, `logo${extension}`), { force: true });
  }
  const fileName = `logo${detected.extension}`;
  fs.writeFileSync(path.join(watermarkDir, fileName), buffer);
  writeJson(logoMetadataPath, {
    fileName,
    originalName: safeName,
    mime: detected.mime,
    size: buffer.length,
    updatedAt: new Date().toISOString(),
  });
  return getWatermarkState();
}

export function clearWatermarkLogo() {
  for (const extension of ['.png', '.jpg', '.webp']) {
    fs.rmSync(path.join(watermarkDir, `logo${extension}`), { force: true });
  }
  fs.rmSync(logoMetadataPath, { force: true });
  const settings = loadWatermarkSettings();
  if (settings.enabled && settings.mode === 'image') {
    writeJson(settingsPath, { ...settings, enabled: false });
  }
  return getWatermarkState();
}

export function getWatermarkLogo() {
  return logoMetadata();
}
