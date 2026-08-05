import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT_PATH = join(__dirname, '../data/clients.json');

function dbPath() {
  return process.env.CLIENTS_DB_PATH || REPO_DEFAULT_PATH;
}

// Seed the volume from the repo default on first boot, matching the Overheads pattern.
function ensureDbFile() {
  const target = dbPath();
  if (existsSync(target)) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const seed = existsSync(REPO_DEFAULT_PATH)
      ? readFileSync(REPO_DEFAULT_PATH, 'utf-8')
      : JSON.stringify({ clients: [] }, null, 2) + '\n';
    writeFileSync(target, seed);
  } catch {
    // If seeding fails (permissions, etc.) loadDb() will fall through to empty
  }
}

function loadDb() {
  ensureDbFile();
  try {
    const raw = readFileSync(dbPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { clients: Array.isArray(parsed.clients) ? parsed.clients : [] };
  } catch {
    return { clients: [] };
  }
}

function saveDb(db) {
  const target = dbPath();
  try { mkdirSync(dirname(target), { recursive: true }); } catch {}
  writeFileSync(target, JSON.stringify(db, null, 2) + '\n');
}

function normaliseCode(code) {
  return String(code || '').trim().toUpperCase();
}

function validateCode(code) {
  if (!/^[A-Z0-9]{2,5}$/.test(code)) {
    throw new Error('code must be 2-5 uppercase letters or digits');
  }
}

function normaliseName(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('customerName required');
  if (clean.length > 200) throw new Error('customerName too long');
  return clean;
}

function normaliseIreland(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

// --- In-memory cache (invalidated on every write) -------------------------

let cache = null;

function cachedClients() {
  if (cache) return cache;
  cache = loadDb().clients.map(c => ({
    code: normaliseCode(c.code),
    customerName: c.customerName,
    isIreland: !!c.isIreland,
  }));
  return cache;
}

function invalidate() { cache = null; }

export function reloadClients() {
  invalidate();
  return cachedClients();
}

// --- Public API -----------------------------------------------------------

export function listClients() {
  return [...cachedClients()].sort((a, b) => a.code.localeCompare(b.code));
}

export function findClient(code) {
  const c = normaliseCode(code);
  return cachedClients().find(x => x.code === c) || null;
}

export function isIrelandClient(code) {
  const c = findClient(code);
  return !!(c && c.isIreland);
}

export function addClient({ code, customerName, isIreland }) {
  const clean = normaliseCode(code);
  validateCode(clean);
  const name = normaliseName(customerName);
  const db = loadDb();
  if (db.clients.some(c => normaliseCode(c.code) === clean)) {
    throw new Error(`Client code "${clean}" already exists`);
  }
  const entry = { code: clean, customerName: name, isIreland: normaliseIreland(isIreland) };
  db.clients.push(entry);
  db.clients.sort((a, b) => normaliseCode(a.code).localeCompare(normaliseCode(b.code)));
  saveDb(db);
  invalidate();
  return entry;
}

export function updateClient(code, { customerName, isIreland }) {
  const clean = normaliseCode(code);
  const db = loadDb();
  const idx = db.clients.findIndex(c => normaliseCode(c.code) === clean);
  if (idx < 0) throw new Error(`Client code "${clean}" not found`);
  const current = db.clients[idx];
  const nextName = customerName === undefined ? current.customerName : normaliseName(customerName);
  const nextIreland = isIreland === undefined ? !!current.isIreland : normaliseIreland(isIreland);
  const entry = { code: clean, customerName: nextName, isIreland: nextIreland };
  db.clients[idx] = entry;
  saveDb(db);
  invalidate();
  return entry;
}

export function deleteClient(code) {
  const clean = normaliseCode(code);
  const db = loadDb();
  const before = db.clients.length;
  db.clients = db.clients.filter(c => normaliseCode(c.code) !== clean);
  if (db.clients.length === before) throw new Error(`Client code "${clean}" not found`);
  saveDb(db);
  invalidate();
  return true;
}
