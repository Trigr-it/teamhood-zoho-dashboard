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
// Ladders are grouped into tracks (Engineering, BIM, ...). Each track has its
// own ordered steps; each step has an editable title, milestone and dated pay
// history. The Engineering ladder below was agreed 2026-10-19. Volume files
// that predate tracks are migrated on load (see normaliseTracks).

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

export const ENGINEERING_TRACK_ID = 'engineering';

function defaultLadderEntries() {
  return DEFAULT_LADDER.map(l => ({
    step: l.step,
    title: l.title,
    milestone: l.milestone,
    payHistory: [{ date: LADDER_SET_DATE, amount: l.pay, note: 'Ladder set' }],
  }));
}

function defaultTracks() {
  return [
    { id: ENGINEERING_TRACK_ID, name: 'Engineering', notes: DEFAULT_LADDER_NOTES, steps: defaultLadderEntries() },
    { id: 'bim', name: 'BIM', notes: '', steps: [] },
  ];
}

function cleanStepRecord(raw) {
  if (!raw || typeof raw.step !== 'string' || !raw.step.trim()) return null;
  return {
    step: raw.step.trim().toUpperCase(),
    title: typeof raw.title === 'string' ? raw.title : '',
    milestone: typeof raw.milestone === 'string' ? raw.milestone : '',
    payHistory: Array.isArray(raw.payHistory) ? raw.payHistory : [],
  };
}

// Accepts the current shape ({ tracks }) or either legacy shape
// ({ ladder: [...steps], ladderNotes } from the single-ladder release, or nothing at all).
function normaliseTracks(parsed) {
  if (Array.isArray(parsed.tracks)) {
    const seen = new Set();
    const tracks = [];
    for (const t of parsed.tracks) {
      if (!t || typeof t.id !== 'string' || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push({
        id: t.id,
        name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : t.id,
        notes: typeof t.notes === 'string' ? t.notes : '',
        steps: (Array.isArray(t.steps) ? t.steps : []).map(cleanStepRecord).filter(Boolean),
      });
    }
    return tracks;
  }
  if (Array.isArray(parsed.ladder)) {
    // Single-ladder release: merge the saved steps over the defaults so every fixed step survives.
    const byStep = new Map(parsed.ladder.map(cleanStepRecord).filter(Boolean).map(l => [l.step, l]));
    const steps = defaultLadderEntries().map(def => byStep.get(def.step) || def);
    for (const [code, l] of byStep) if (!steps.some(s => s.step === code)) steps.push(l);
    return [
      { id: ENGINEERING_TRACK_ID, name: 'Engineering', notes: typeof parsed.ladderNotes === 'string' ? parsed.ladderNotes : DEFAULT_LADDER_NOTES, steps },
      { id: 'bim', name: 'BIM', notes: '', steps: [] },
    ];
  }
  return defaultTracks();
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
      tracks: normaliseTracks(parsed),
    };
  } catch {
    return { staff: [], recurring: [], tracks: defaultTracks() };
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

  // Schedule: probation (3mo), then a review every 6 months for the whole tenure.
  const schedule = [{ label: 'End of probation', months: 3 }];
  for (let m = 6; m <= 40 * 12; m += 6) {
    const years = m / 12;
    const label = m === 6 ? '6-month review'
      : m === 18 ? '18-month review'
      : `${years}-year review`; // 1-year, 2-year, 2.5-year, 3-year, ...
    schedule.push({ label, months: m });
  }

  const milestones = schedule.map(m => {
    const date = addMonths(startIso, m.months);
    return { label: m.label, date, daysAway: daysBetween(todayIsoStr, date) };
  });

  // Show anything from a fortnight ago up to two years ahead.
  const TWO_YEARS_DAYS = 731;
  const probation = milestones[0];
  const upcoming = milestones.filter(m => m.daysAway >= -14 && m.daysAway <= TWO_YEARS_DAYS);
  const next = upcoming.find(m => m.daysAway >= 0) || null;

  return { probation, upcoming, next };
}

// --- Staff shape for API --------------------------------------------------

function computeStaffView(s, todayIsoStr, tracks) {
  const trackById = new Map((tracks || []).map(t => [t.id, t]));
  const resolve = (trackId, stepCode) => {
    const t = trackId ? trackById.get(trackId) : null;
    const l = t ? t.steps.find(x => x.step === stepCode) : null;
    return l ? { track: t.id, trackName: t.name, step: l.step, role: l.title } : null;
  };
  const sorted = [...(s.salaryHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  // The ladder step is carried on salary entries so promotions are dated.
  // An entry without a step inherits the step in force before it (pay-only rises, legacy rows).
  // Entries from the single-ladder release have a step but no track: they belong to Engineering.
  let inForce = null; // { track, step }
  const history = sorted.map(h => {
    const entryTrack = h.step ? (h.track || ENGINEERING_TRACK_ID) : null;
    const promoted = !!(h.step && inForce && (h.step !== inForce.step || entryTrack !== inForce.track));
    if (h.step) inForce = { track: entryTrack, step: h.step };
    const r = inForce ? resolve(inForce.track, inForce.step) : null;
    return {
      date: h.date,
      amount: h.amount,
      note: h.note || '',
      track: entryTrack,
      step: h.step || null,
      effectiveTrack: r ? r.track : null,
      effectiveStep: r ? r.step : null,
      trackName: r ? r.trackName : null,
      role: r ? r.role : null,
      promoted,
    };
  });
  // s.step is the legacy per-person field from the short-lived dropdown; honoured only if no entry carries a step.
  const current = inForce ? resolve(inForce.track, inForce.step) : (s.step ? resolve(ENGINEERING_TRACK_ID, s.step) : null);
  let stepSince = null;
  if (current) {
    // First entry of the latest unbroken run of the current step.
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].effectiveStep !== current.step || history[i].effectiveTrack !== current.track) break;
      stepSince = history[i].date;
    }
  }
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
    track: current ? current.track : null,
    trackName: current ? current.trackName : null,
    step: current ? current.step : null,
    role: current ? current.role : null,
    stepSince,
    promotions: history.filter(h => h.promoted).map(h => ({ date: h.date, track: h.track, step: h.step })),
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
  return db.staff.map(s => computeStaffView(s, today, db.tracks));
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
  return computeStaffView(s, todayIso(), db.tracks);
}

// Resolve a {track, step} reference from a salary entry payload. A bare step with no
// track is taken as Engineering (the only track that existed before tracks were added).
function cleanStepRef(db, track, step) {
  const code = step ? String(step).trim().toUpperCase() : null;
  if (!code) return { track: null, step: null };
  const trackId = track ? String(track).trim() : ENGINEERING_TRACK_ID;
  const t = db.tracks.find(x => x.id === trackId);
  if (!t) throw new Error(`Unknown track: ${trackId}`);
  if (!t.steps.some(l => l.step === code)) throw new Error(`Unknown step ${code} on ${t.name}`);
  return { track: t.id, step: code };
}

export function addSalaryEntry(id, { date, amount, note, track, step }) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  const ref = cleanStepRef(db, track, step);
  s.salaryHistory = s.salaryHistory || [];
  s.salaryHistory.push({ date, amount: amt, note: (note || '').slice(0, 200), track: ref.track, step: ref.step });
  s.salaryHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveDb(db);
  return computeStaffView(s, todayIso(), db.tracks);
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
  return computeStaffView(s, todayIso(), db.tracks);
}

export function updateSalaryEntry(id, index, { date, amount, note, track, step }) {
  const db = loadDb();
  const s = db.staff.find(x => x.id === id);
  if (!s) throw new Error(`Staff not found: ${id}`);
  const history = [...(s.salaryHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  const ref = cleanStepRef(db, track, step);
  history[index] = { date, amount: amt, note: (note || '').slice(0, 200), track: ref.track, step: ref.step };
  history.sort((a, b) => a.date.localeCompare(b.date));
  s.salaryHistory = history;
  saveDb(db);
  return computeStaffView(s, todayIso(), db.tracks);
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
  return { view: computeStaffView(s, todayIso(), db.tracks), removed };
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

// --- Career ladder (tracks + steps) ---------------------------------------

function computeStepView(l, prevPay) {
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

function trackView(t) {
  let prevPay = null;
  const steps = t.steps.map(l => {
    const view = computeStepView(l, prevPay);
    if (view.currentPay != null) prevPay = view.currentPay;
    return view;
  });
  return { id: t.id, name: t.name, notes: t.notes, steps };
}

function trackViews(db) {
  return db.tracks.map(trackView);
}

export function getLadder() {
  const db = loadDb();
  return { tracks: trackViews(db) };
}

function findTrack(db, trackId) {
  const t = db.tracks.find(x => x.id === trackId);
  if (!t) throw new Error(`Track not found: ${trackId}`);
  return t;
}

function findStep(track, stepCode) {
  const code = String(stepCode || '').trim().toUpperCase();
  const l = track.steps.find(x => x.step === code);
  if (!l) throw new Error(`Ladder step not found: ${track.id}/${code}`);
  return l;
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function staffReferencing(db, trackId, stepCode) {
  const names = new Set();
  for (const s of db.staff) {
    for (const h of (s.salaryHistory || [])) {
      const t = h.track || (h.step ? ENGINEERING_TRACK_ID : null);
      if (t === trackId && (stepCode == null || h.step === stepCode)) names.add(s.name);
    }
    if (stepCode == null && s.step && trackId === ENGINEERING_TRACK_ID) names.add(s.name);
  }
  return [...names];
}

// -- tracks

export function addTrack({ name }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('name required');
  if (cleanName.length > 60) throw new Error('name too long');
  const db = loadDb();
  let id = slugify(cleanName);
  if (!id) throw new Error('name must contain letters or numbers');
  if (db.tracks.some(t => t.id === id)) throw new Error(`A track called "${cleanName}" already exists`);
  db.tracks.push({ id, name: cleanName, notes: '', steps: [] });
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function updateTrack(trackId, { name, notes }) {
  const db = loadDb();
  const t = findTrack(db, trackId);
  if (name !== undefined) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('name required');
    if (cleanName.length > 60) throw new Error('name too long');
    t.name = cleanName;
  }
  if (notes !== undefined) t.notes = String(notes || '').slice(0, 5000);
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function deleteTrack(trackId) {
  const db = loadDb();
  findTrack(db, trackId);
  const refs = staffReferencing(db, trackId, null);
  if (refs.length) throw new Error(`Cannot delete: salary entries for ${refs.join(', ')} reference this track`);
  db.tracks = db.tracks.filter(t => t.id !== trackId);
  saveDb(db);
  return { tracks: trackViews(db) };
}

// -- steps

function validatePayInput({ date, amount, note }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
  return { date, amount: amt, note: (note || '').slice(0, 200) };
}

export function addStep(trackId, { step, title, milestone, date, amount, note }) {
  const db = loadDb();
  const t = findTrack(db, trackId);
  const code = String(step || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(code)) throw new Error('step code must be 1–6 letters or digits (e.g. B1)');
  if (t.steps.some(x => x.step === code)) throw new Error(`Step ${code} already exists on ${t.name}`);
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('title required');
  if (cleanTitle.length > 100) throw new Error('title too long');
  const payHistory = [];
  if (amount != null && amount !== '') {
    payHistory.push(validatePayInput({ date: date || todayIso(), amount, note: note || 'Step created' }));
  }
  t.steps.push({ step: code, title: cleanTitle, milestone: String(milestone || '').trim().slice(0, 500), payHistory });
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function updateStep(trackId, stepCode, { title, milestone }) {
  const db = loadDb();
  const l = findStep(findTrack(db, trackId), stepCode);
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) throw new Error('title required');
  if (cleanTitle.length > 100) throw new Error('title too long');
  l.title = cleanTitle;
  l.milestone = String(milestone || '').trim().slice(0, 500);
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function moveStep(trackId, stepCode, direction) {
  const db = loadDb();
  const t = findTrack(db, trackId);
  const l = findStep(t, stepCode);
  const i = t.steps.indexOf(l);
  const j = direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= t.steps.length) return { tracks: trackViews(db) };
  [t.steps[i], t.steps[j]] = [t.steps[j], t.steps[i]];
  saveDb(db);
  return { tracks: trackViews(db) };
}

// Full reorder (drag and drop): `order` must list every step code on the track exactly once.
export function reorderSteps(trackId, order) {
  const db = loadDb();
  const t = findTrack(db, trackId);
  if (!Array.isArray(order)) throw new Error('order must be an array of step codes');
  const codes = order.map(c => String(c || '').trim().toUpperCase());
  const current = t.steps.map(l => l.step);
  const valid = codes.length === current.length
    && new Set(codes).size === codes.length
    && codes.every(c => current.includes(c));
  if (!valid) throw new Error('order must list every step on the track exactly once');
  t.steps = codes.map(c => t.steps.find(l => l.step === c));
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function deleteStep(trackId, stepCode) {
  const db = loadDb();
  const t = findTrack(db, trackId);
  const l = findStep(t, stepCode);
  const refs = staffReferencing(db, trackId, l.step);
  if (refs.length) throw new Error(`Cannot delete: salary entries for ${refs.join(', ')} are on ${l.step}`);
  t.steps = t.steps.filter(x => x !== l);
  saveDb(db);
  return { tracks: trackViews(db) };
}

// -- step pay history

export function addStepPay(trackId, stepCode, input) {
  const db = loadDb();
  const l = findStep(findTrack(db, trackId), stepCode);
  l.payHistory = l.payHistory || [];
  l.payHistory.push(validatePayInput(input));
  l.payHistory.sort((a, b) => a.date.localeCompare(b.date));
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function updateStepPay(trackId, stepCode, index, input) {
  const db = loadDb();
  const l = findStep(findTrack(db, trackId), stepCode);
  const history = [...(l.payHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  history[index] = validatePayInput(input);
  history.sort((a, b) => a.date.localeCompare(b.date));
  l.payHistory = history;
  saveDb(db);
  return { tracks: trackViews(db) };
}

export function deleteStepPay(trackId, stepCode, index) {
  const db = loadDb();
  const l = findStep(findTrack(db, trackId), stepCode);
  const history = [...(l.payHistory || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (index < 0 || index >= history.length) throw new Error('index out of range');
  l.payHistory = history.filter((_, i) => i !== index);
  saveDb(db);
  return { tracks: trackViews(db) };
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
