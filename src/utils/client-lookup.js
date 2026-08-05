import { listClients, findClient, isIrelandClient as storeIsIreland, reloadClients } from '../clients.js';

/**
 * Look up Zoho customer name by client code.
 * Returns { code, customerName } or null if not found.
 */
export function lookupClient(code) {
  if (!code) return null;
  const c = findClient(code);
  if (!c) return null;
  return { code: c.code, customerName: c.customerName };
}

/**
 * Get all client mappings.
 */
export function getAllClients() {
  return listClients().map(c => ({ code: c.code, customerName: c.customerName }));
}

/**
 * True if a client code should route to the Ireland salesperson + Zero VAT.
 */
export function isIrelandClient(code) {
  return storeIsIreland(code);
}

/**
 * Force reload from disk after an external edit.
 */
export function reloadClientMap() {
  return reloadClients();
}
