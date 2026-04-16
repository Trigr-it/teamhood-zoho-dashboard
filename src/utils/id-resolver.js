/**
 * Detect and resolve Teamhood display IDs (e.g. "ROWO-13383") vs UUIDs.
 */

const DISPLAY_ID_PATTERN = /^[A-Z]+-\d+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDisplayId(id) {
  return DISPLAY_ID_PATTERN.test(id);
}

export function isUuid(id) {
  return UUID_PATTERN.test(id);
}

/**
 * Extract a display ID from a Teamhood card URL.
 * URL format: https://node.teamhood.com/ROWO/Board/LIPR/ROWO-13383
 */
export function extractDisplayIdFromUrl(url) {
  const match = url.match(/([A-Z]+-\d+)\s*$/);
  return match ? match[1] : null;
}

/**
 * In-memory cache mapping display IDs to UUIDs.
 */
const displayIdCache = new Map();

export function cacheDisplayId(displayId, uuid) {
  displayIdCache.set(displayId, uuid);
}

export function getCachedUuid(displayId) {
  return displayIdCache.get(displayId) || null;
}

/**
 * Index an array of items into the display ID cache.
 * Each item must have `id` (UUID) and a display ID field.
 */
export function indexItems(items, displayIdField = 'displayId') {
  for (const item of items) {
    const did = item[displayIdField] || item.number;
    if (did && item.id) {
      displayIdCache.set(did, item.id);
    }
  }
}
