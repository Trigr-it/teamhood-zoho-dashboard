import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = join(__dirname, '../../client-identifiers.txt');

let clientMap = null;

/**
 * Parse client-identifiers.txt into a Map of code → client name.
 * Cached after first load.
 */
function loadClientMap() {
  if (clientMap) return clientMap;

  clientMap = new Map();
  try {
    const text = readFileSync(CLIENT_FILE, 'utf-8');
    for (const line of text.split('\n')) {
      // Match lines like "PRO   Proplant Scaffolding"
      const match = line.match(/^([A-Z0-9]{2,5})\s{2,}(.+)$/);
      if (match) {
        clientMap.set(match[1].trim(), match[2].trim());
      }
    }
  } catch (err) {
    console.warn(`[client-lookup] Could not read ${CLIENT_FILE}: ${err.message}`);
  }

  return clientMap;
}

/**
 * Look up Zoho customer name by client code.
 * Returns { code, customerName } or null if not found.
 */
export function lookupClient(code) {
  if (!code) return null;
  const map = loadClientMap();
  const name = map.get(code.toUpperCase());
  if (!name) return null;
  return { code: code.toUpperCase(), customerName: name };
}

/**
 * Get all client mappings.
 */
export function getAllClients() {
  const map = loadClientMap();
  return [...map.entries()].map(([code, name]) => ({ code, customerName: name }));
}

/**
 * Force reload from disk (call after updating the file).
 */
export function reloadClientMap() {
  clientMap = null;
  return loadClientMap();
}
