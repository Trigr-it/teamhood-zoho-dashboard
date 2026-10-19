import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT_PATH = join(__dirname, '../data/staff.json');

function dbPath() {
  return process.env.STAFF_DB_PATH || REPO_DEFAULT_PATH;
}

// --- Career ladder defaults ----------------------------------------------
// Ladder agreed 2026-10-19. Steps are fixed; title, milestone and pay history
// are editable from the Team Salary tab. Existing volume files that predate
// the ladder get these defaults merged in on load (see loadDb).

const LADDER_SET_DATE = '2026-10-19';

export const DEFAULT_LADDER = [
  { step: 'G1', title: 'Graduate Design Engineer', milestone: 'Entry: produces designs under supervision', pay: 36000 },
  { step: 'G2', title: 'Graduate Design Engineer', milestone: 'Works independently on standard designs; few corrections at sign-off', pay: 38000 },
  { step: 'D1', title: 'Design Engineer', milestone: 'Runs own small projects end to end; designs pass sign-off with only minor comments', pay: 40000 },
  { step: 'D2', title: 'Design Engineer', milestone: 'Handles client queries directly; quotes simple jobs; leads medium projects', pay: 42000 },
  { step: 'I1', title: 'Design Engineer', milestone: 'Cat 0–1 sign-off authority; resolves site queries independently', pay: 45000 },
  { step: 'I2', title: 'Design Engineer', milestone: '6+ months of clean sign-offs; supports a graduate; runs client relationships', pay: 48000 },
  { step: 'S1', title: 'Senior Design Engineer', milestone: 'Cat 2 checks; mentors juniors; trusted on complex or high-risk work', pay: 52000 },
  { step: 'S2', title: 'Senior Design Engineer', milestone: "Reviews other checkers' work; takes over directors' remaining design responsibilities", pay: 56000 },
];

export const DEFAULT_LADDER_NOTES = [
  'Eight steps across four grades: Graduate (G1–G2), Design Engineer (D1–D2), sign-off level (I1–I2) and Senior (S1–S2). Pay rises in steps of about £2k up to D2 and £3–4k above that.',
  'Progression is reviewed at the standard milestones tracked above (end of probation, 6 months, 1 year, 18 months, 2 years, then yearly). Every step from here on depends on meeting the milestone for the next step, not on time served.',
  'D2 is the top of the D grade. Good, steady producers sit there and only move up if they take on sign-off responsibility at I1.',
  'G1 sits at the top of the London graduate range (£28–36k), so new graduate offers stay competitive.',
  'Placement of current team: 2–3 year engineers on £42k go to D2. The 2-year engineer on £40k goes to D1. The 1-year engineer already promised £40k is honoured: either they meet the D1 milestones at the next review, or they are placed at D1 on the strength of the promise with every further step tied to milestones.',
].join('\n\n');

function defaultLadderEntries() {
  return DEFAULT_LADDER.map(l => ({
    step: l.step,
    title: l.title,
    milestone: l.milestone,
    payHistory: [{ date: LADDER_SET_DATE, amount: l.pay, note: 'Ladder set' }],
  }));
}

// Merge whatever is on disk with the defaults so every fixed step exists.
function normaliseLadder(raw) {
  const byStep = new Map((Array.isArray(raw) ? raw : []).map(l => [l.step, l]));
  return defaultLadderEntries().map(def => {
    const existing = byStep.get(def.step);
    if (!existing) return def;
    return {
      step: def.step,
      title: typeof existing.title === 'string' ? existing.title : def.title,
      milestone: typeof existing.milestone === 'string' ? existing.milestone : def.milestone,
      payHistory: Array.isArray(existing.payHistory) ? existing.payHistory : def.payHistory,
    };
  });
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
      ladder: normaliseLadder(parsed.ladder),
      ladderNotes: typeof parsed.ladderNotes === 'string' ? parsed.ladderNotes : DEFAULT_LADDER_NOTES,
    };
  } catch {
    return { staff: [], recurring: [], ladder: normaliseLadder([]), ladderNotes: DEFAULT_LADDER_NOTES };
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

function computeStaffView(s, todayIsoStr, ladder) {
  const stepEntry = s.step ? (ladder || []).find(l => l.step === s.step) : null;
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
    step: stepEntry ? stepEntry.step : null,
    role: stepEntry ? stepEntry.title : null,
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
  return db.staff.map(s => computeStaffView(s, today, db.ladder));
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
  return computeStaffView(s, todayIso(), db.ladder);
}

export function updateStaffStep(id, step) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  const clean = step ? String(step).trim().toUpperCase() : null;
  if (clean && !db.ladder.some(l => l.step === clean)) throw new Error(`Unknown ladder step: ${clean}`);
  s.step = clean;
  saveDb(db);
  return computeStaffView(s, todayIso(), db.ladder);
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
  return computeStaffView(s, todayIso(), db.ladder);
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
  return computeStaffView(s, todayIso(), db.ladder);
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
  return computeStaffView(s, todayIso(), db.ladder);
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
  return { view: computeStaffView(s, todayIso(), db.ladder), removed };
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

// --- Career ladder --------------------------------------------------------

function computeLadderView(l, prevPay) {
  const history = [...(l.payHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  const current = history.length ? history[history.length - 1] : null;
  const first = history.length ? history[0] : null;
  const previous = history.length > 1 ? history[history.length - 2] : null;
  return {
    step: l.step,
    grade: l.step.charAt(0),
    title: l.title,
    milestone: l.milestone,
    currentPay: current ? current.amount : null,
    lastChangeDate: current ? current.date : null,
    lastChangeAmount: previous && current ? current.amount - previous.amount : null,
    growthFromFirst: first && current ? current.amount - first.amount : null,
    stepFromBelow: (current && prevPay != null) ? current.amount - prevPay : null,
    payHistory: history,
  };
}

function ladderViews(db) {
  let prevPay = null;
  return db.ladder.map(l => {
    const view = computeLadderView(l, prevPay);
    prevPay = view.currentPay;
    return view;
  });
}

export function getLadder() {
  const db = loadDb();
  return { steps: ladderViews(db), notes: db.ladderNotes };
}

export function updateLadderNotes(notes) {
  const db = loadDb();
  db.ladderNotes = String(notes || '').slice(0, 5000);
  saveDb(db);
  return db.ladderNotes;
}

function findStep(db, step) {
  const l = db.ladder.find(x => x.step === step);
  if (!l) throw new Error(`Ladder step not found: ${step}`);
  return l;
}

export function updateLadderStep(step, { title, milestone }) {
  const db = loadDb();
  const l = findStep(db, step);
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('title required');
  if (cleanTitle.length > 100) throw new Error('title too long');
  l.title = cleanTitle;
  l.milestone = String(milestone || '').trim().slice(0, 500);
  saveDb(db);
  return { steps: ladderViews(db) };
}

function validatePayInput({ date, amount, note }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  return { date, amount: amt, note: (note || '').slice(0, 200) };
}

export function addLadderPayEntry(step, input) {
  const db = loadDb();
  const l = findStep(db, step);
  const entry = validatePayInput(input);
  l.payHistory = l.payHistory || [];
  l.payHistory.push(entry);
  l.payHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveDb(db);
  return { steps: ladderViews(db) };
}

export function updateLadderPayEntry(step, index, input) {
  const db = loadDb();
  const l = findStep(db, step);
  const history = [...(l.payHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  history[index] = validatePayInput(input);
  history.sort((a, b) => a.date.localeCompare(b.date));
  l.payHistory = history;
  saveDb(db);
  return { steps: ladderViews(db) };
}

export function deleteLadderPayEntry(step, index) {
  const db = loadDb();
  const l = findStep(db, step);
  const history = [...(l.payHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  l.payHistory = history.filter((_, i) => i !== index);
  saveDb(db);
  return { steps: ladderViews(db) };
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
