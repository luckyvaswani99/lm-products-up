import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { slugify } from '../store.js';

/**
 * The category lanes: one seller category page each, with its own browser
 * profile and its own product group.
 *
 * Kept on disk rather than in the page for the same reason the upload toggles
 * are: a lane set that lives only in the browser is lost on refresh, and a run
 * would then quietly do something other than what was configured.
 *
 * Each lane holds:
 *   id       stable slug, also the name of its browser profile directory
 *   url      the seller category page this lane extracts
 *   group    the IndiaMART product group its uploads go into ('' = leave alone)
 *   enabled  off keeps the lane configured without running it
 */
const settingsPath = path.join(config.dataDir, 'lanes.json');

/**
 * The five categories this account is working through.
 *
 * The groups are deliberately blank. Which account group a category belongs in
 * is a decision about this business, and the seller's category name is not the
 * account's group name — the account carries "Anti Cancer Medicine" and
 * "Women Health Medicine" but has no pain-killer group at all. Guessing the
 * mapping would file real listings under a group nobody chose, so the group is
 * picked from the account's own list (see readAccountGroups) and saved here.
 */
export const DEFAULT_LANES = [
  {
    id: 'nervous-system-medicines',
    url: 'https://www.indiamart.com/silverlinemedicare/nervous-system-medicines.html',
    group: '',
    enabled: true,
  },
  {
    id: 'female-health-care-product',
    url: 'https://www.indiamart.com/silverlinemedicare/female-health-care-product.html',
    group: '',
    enabled: true,
  },
  {
    id: 'mens-health',
    url: 'https://www.indiamart.com/silverlinemedicare/mens-health.html',
    group: '',
    enabled: true,
  },
  {
    id: 'pain-killer-medicines',
    url: 'https://www.indiamart.com/silverlinemedicare/pain-killer-medicines.html',
    group: '',
    enabled: true,
  },
  {
    id: 'anti-cancer-medicines',
    url: 'https://www.indiamart.com/silverlinemedicare/anti-cancer-medicines.html',
    group: '',
    enabled: true,
  },
];

/** Where a lane's own Chromium profile lives. One profile per lane, always. */
export function laneSessionDir(id) {
  return path.join(config.root, '.session-lanes', id);
}

/** A lane URL must be a seller category page; anything else is rejected loudly. */
export function normaliseLane(input = {}, index = 0) {
  const url = String(input.url || '').trim();
  if (!url) throw new Error(`lane ${index + 1} has no category URL`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`lane ${index + 1}: "${url}" is not a URL`);
  }
  if (!/(^|\.)indiamart\.com$/i.test(parsed.hostname)) {
    throw new Error(`lane ${index + 1}: ${parsed.hostname} is not indiamart.com`);
  }
  const id = slugify(input.id || parsed.pathname.split('/').pop().replace(/\.html?$/i, '')) ||
    `lane-${index + 1}`;
  return {
    id,
    url,
    group: String(input.group || '').trim(),
    enabled: input.enabled !== false,
  };
}

export function loadLanes() {
  if (fs.existsSync(settingsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const lanes = Array.isArray(data?.lanes) ? data.lanes : [];
      if (lanes.length) return lanes.map((lane, index) => normaliseLane(lane, index));
    } catch {
      // fall through to the defaults
    }
  }
  return DEFAULT_LANES.map((lane, index) => normaliseLane(lane, index));
}

export function saveLanes(lanes = []) {
  const normalised = lanes.map((lane, index) => normaliseLane(lane, index));
  const seen = new Set();
  for (const lane of normalised) {
    if (seen.has(lane.id)) {
      throw new Error(`two lanes share the id "${lane.id}" — they would share one browser profile`);
    }
    seen.add(lane.id);
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ lanes: normalised }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, settingsPath);
  return normalised;
}
