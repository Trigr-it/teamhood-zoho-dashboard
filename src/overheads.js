import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT_PATH = join(__dirname, '../data/staff.json');

function dbPath() {
  return process.env.STAFF_DB_PATH || REPO_DEFAULT_PATH;
}

// On first boot with a fresh volume, the target file won't exist yet.
// Seed it from the repo default so the tab isn't empty on first load.
function ensureDbFile() {
  const target = dbPath();
  if (existsSync(target)) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const seed = existsSync(REPO_DEFAULT_PATH)
      ? readFileSync(REPO_DEFAULT_PATH, 'utf-8')
      : JSON.stringify({ staff: [] }, null, 2) + '\n';
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
    return {
      staff: Array.isArray(parsed.staff) ? parsed.staff : [],
      recurring: Array.isArray(parsed.recurring) ? parsed.recurring : [],
    };
  } catch {
    return { staff: [], recurring: [] };
  }
}

function saveDb(db) {
  const target = dbPath();
  try { mkdirSync(dirname(target), { recursive: true }); } catch {}
  writeFileSync(target, JSON.stringify(db, null, 2) + '\n');
}

// --- Date helpers ---------------------------------------------------------

function addMonths(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
  // Clamp for months without the source day (e.g. 31st → 30/28)
  if (target.getUTCDate() !== d.getUTCDate()) {
    target.setUTCDate(0);
  }
  return target.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso + 'T00:00:00Z').getTime();
  const to = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((to - from) / 86400000);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function tenureLabel(startIso, todayIsoStr) {
  const start = new Date(startIso + 'T00:00:00Z');
  const now = new Date(todayIsoStr + 'T00:00:00Z');
  let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years === 0) return `${months}mo`;
  if (rem === 0) return `${years}y`;
  return `${years}y ${rem}mo`;
}

// --- Milestones -----------------------------------------------------------

function buildMilestones(startIso, todayIsoStr) {
  if (!startIso) return { probation: null, upcoming: [], next: null };

  // Schedule: probation (3mo), 6mo, 1yr, 18mo, 2yr, then yearly.
  const schedule = [
    { label: 'End of probation', months: 3 },
    { label: '6-month review', months: 6 },
    { label: '1-year review', months: 12 },
    { label: '18-month review', months: 18 },
    { label: '2-year review', months: 24 },
  ];
  for (let y = 3; y <= 40; y++) {
    schedule.push({ label: `${y}-year review`, months: y * 12 });
  }

  const milestones = schedule.map(m => {
    const date = addMonths(startIso, m.months);
    return { label: m.label, date, daysAway: daysBetween(todayIsoStr, date) };
  });

  const probation = milestones[0];
  const upcoming = milestones.filter(m => m.daysAway >= -14).slice(0, 6);
  const next = upcoming.find(m => m.daysAway >= 0) || null;

  return { probation, upcoming, next };
}

// --- Staff shape for API --------------------------------------------------

function computeStaffView(s, todayIsoStr) {
  const history = [...(s.salaryHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  const currentSalary = history.length ? history[history.length - 1].amount : null;
  const startingSalary = history.length ? history[0].amount : null;
  const growthPct = (currentSalary && startingSalary && startingSalary > 0)
    ? Math.round(((currentSalary - startingSalary) / startingSalary) * 1000) / 10
    : null;
  const tenure = s.startDate ? tenureLabel(s.startDate, todayIsoStr) : null;
  const milestones = buildMilestones(s.startDate, todayIsoStr);
  return {
    id: s.id,
    name: s.name,
    startDate: s.startDate || null,
    tenure,
    currentSalary,
    startingSalary,
    growthPct,
    salaryHistory: history,
    milestones,
  };
}

// --- Public API -----------------------------------------------------------

export function listStaff() {
  const today = todayIso();
  const db = loadDb();
  return db.staff.map(s => computeStaffView(s, today));
}

export function updateStartDate(id, startDate) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error('startDate must be YYYY-MM-DD');
  }
  s.startDate = startDate || null;
  saveDb(db);
  return computeStaffView(s, todayIso());
}

export function addSalaryEntry(id, { date, amount, note }) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  s.salaryHistory = s.salaryHistory || [];
  s.salaryHistory.push({ date, amount: amt, note: (note || '').slice(0, 200) });
  s.salaryHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveDb(db);
  return computeStaffView(s, todayIso());
}

export function updateSalaryNote(id, index, note) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  const history = [...(s.salaryHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  history[index] = { ...history[index], note: (note || '').slice(0, 200) };
  s.salaryHistory = history;
  saveDb(db);
  return computeStaffView(s, todayIso());
}

export function updateSalaryEntry(id, index, { date, amount, note }) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  const history = [...(s.salaryHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  history[index] = { date, amount: amt, note: (note || '').slice(0, 200) };
  history.sort((a, b) => a.date.localeCompare(b.date));
  s.salaryHistory = history;
  saveDb(db);
  return computeStaffView(s, todayIso());
}

export function deleteSalaryEntry(id, index) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  const history = [...(s.salaryHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  const removed = history[index];
  s.salaryHistory = history.filter((_, i) => i !== index);
  saveDb(db);
  return { view: computeStaffView(s, todayIso()), removed };
}

// --- Recurring expenses ---------------------------------------------------

function computeRecurringView(e) {
  const amount = Number(e.amount) || 0;
  const monthly = e.frequency === 'yearly' ? amount / 12 : amount;
  const yearly = e.frequency === 'yearly' ? amount : amount * 12;
  return {
    id: e.id,
    name: e.name,
    amount,
    frequency: e.frequency,
    monthly,
    yearly,
  };
}

function normaliseRecurringInput({ name, amount, frequency }) {
  const cleanName = (name || '').trim();
  if (!cleanName) throw new Error('name required');
  if (cleanName.length > 100) throw new Error('name too long');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  if (frequency !== 'monthly' && frequency !== 'yearly') throw new Error('frequency must be "monthly" or "yearly"');
  return { name: cleanName, amount: amt, frequency };
}

export function listRecurring() {
  const db = loadDb();
  return db.recurring.map(computeRecurringView);
}

export function addRecurring(input) {
  const { name, amount, frequency } = normaliseRecurringInput(input);
  const db = loadDb();
  const entry = { id: randomUUID(), name, amount, frequency };
  db.recurring.push(entry);
  saveDb(db);
  return computeRecurringView(entry);
}

export function updateRecurring(id, input) {
  const { name, amount, frequency } = normaliseRecurringInput(input);
  const db = loadDb();
  const idx = db.recurring.findIndex(e => e.id === id);
  if (idx < 0) throw new Error(`Recurring expense not found: ${id}`);
  db.recurring[idx] = { id, name, amount, frequency };
  saveDb(db);
  return computeRecurringView(db.recurring[idx]);
}

export function deleteRecurring(id) {
  const db = loadDb();
  const before = db.recurring.length;
  db.recurring = db.recurring.filter(e => e.id !== id);
  if (db.recurring.length === before) throw new Error(`Recurring expense not found: ${id}`);
  saveDb(db);
  return true;
}

// --- Auth -----------------------------------------------------------------

export function overheadsPassword() {
  return process.env.DASH_PASSWORD_OVERHEADS || 'overheads';
}

export function passwordToken(pw) {
  return createHash('sha256').update(pw).digest('hex');
}

export function isAuthorized(req) {
  const cookie = (req.headers.cookie || '')
    .split(';').map(c => c.trim()).find(c => c.startsWith('overheads_auth='));
  if (!cookie) return false;
  const token = cookie.split('=')[1];
  return token === passwordToken(overheadsPassword());
}

export function authCookieValue() {
  return passwordToken(overheadsPassword());
}
