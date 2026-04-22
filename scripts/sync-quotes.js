/**
 * Incremental sync: fetches new Zoho estimates since the latest in the DB
 * and merges them into data/quote_reference_db.json.
 *
 * Usage: PORT=3457 node --env-file=.env scripts/sync-quotes.js
 */

import { zohoRequest } from '../src/zoho/api.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../data/quote_reference_db.json');

const db = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
const existingIds = new Set(db.map(q => q.estimate_id));
console.log(`Current DB: ${db.length} quotes, latest: ${db[0].estimate_number} (${db[0].date})`);

const sinceDate = db[0].date;
const allEstimates = [];
for (const status of ['draft', 'sent', 'accepted', 'invoiced', 'declined']) {
  let page = 1;
  while (true) {
    const data = await zohoRequest('GET', `/estimates?per_page=200&page=${page}&status=${status}&sort_column=date&sort_order=D`);
    const ests = data.estimates || [];
    const recent = ests.filter(e => e.date >= sinceDate);
    allEstimates.push(...recent);
    if (!data.page_context?.has_more_page || recent.length < ests.length) break;
    page++;
  }
  await new Promise(r => setTimeout(r, 200));
}

const newEstimates = allEstimates.filter(e => !existingIds.has(e.estimate_id));
console.log(`Found ${allEstimates.length} estimates since ${sinceDate}, ${newEstimates.length} new`);

if (newEstimates.length === 0) {
  console.log('Nothing to sync.');
  process.exit(0);
}

const newQuotes = [];
for (let i = 0; i < newEstimates.length; i += 5) {
  const batch = newEstimates.slice(i, i + 5);
  const details = await Promise.all(batch.map(est =>
    zohoRequest('GET', `/estimates/${est.estimate_id}`)
  ));
  for (const detail of details) {
    const est = detail.estimate;
    if (!est) continue;
    newQuotes.push({
      estimate_id: est.estimate_id,
      estimate_number: est.estimate_number,
      date: est.date,
      status: est.status,
      client: est.customer_name,
      client_id: est.customer_id,
      project: est.project?.project_name || '',
      project_id: est.project?.project_id || '',
      reference: est.reference_number || '',
      salesperson: est.salesperson_name || '',
      line_items: (est.line_items || []).map(li => ({
        name: li.name,
        description: li.description || '',
        quantity: li.quantity,
        rate: li.rate,
        total: li.item_total,
      })),
      sub_total: est.sub_total,
      tax_total: est.tax_total,
      total: est.total,
    });
  }
  if (i + 5 < newEstimates.length) await new Promise(r => setTimeout(r, 300));
  process.stdout.write(`  Fetched ${Math.min(i + 5, newEstimates.length)}/${newEstimates.length}\r`);
}

console.log(`\nFetched details for ${newQuotes.length} new quotes`);

const merged = [...newQuotes, ...db].sort((a, b) =>
  (b.date || '').localeCompare(a.date || '') || (b.estimate_number || '').localeCompare(a.estimate_number || '')
);
writeFileSync(DB_PATH, JSON.stringify(merged, null, 2));
console.log(`Updated DB: ${merged.length} quotes (+${newQuotes.length}), latest: ${merged[0].estimate_number} (${merged[0].date})`);
