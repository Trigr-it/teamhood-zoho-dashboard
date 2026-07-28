import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

function dbPath() {
  return process.env.STAFF_DB_PATH || join(__dirname, '../data/staff.json');
}

function loadDb() {
  try {
    const raw = readFileSync(dbPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.staff) ? parsed : { staff: [] };
  } catch {
    return { staff: [] };
  }
}

function saveDb(db) {
  writeFileSync(dbPath(), JSON.stringify(db, null, 2) + '\n');
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
