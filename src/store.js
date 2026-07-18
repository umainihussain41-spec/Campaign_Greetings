// Tiny file-backed store — no external database. Everything lives in one
// JSON file next to the MP3s (DATA_DIR). Fine for this workload: a handful
// of greetings/campaigns and a stream of call rows. Writes are serialized
// and atomic (temp file + rename).
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'db.json');
const EMPTY = { greetings: [], campaigns: [], campaign_numbers: [], calls: [] };

let data = structuredClone(EMPTY);
let writeChain = Promise.resolve();

export function initStore() {
  fssync.mkdirSync(config.dataDir, { recursive: true });
  if (fssync.existsSync(FILE)) {
    try { data = { ...EMPTY, ...JSON.parse(fssync.readFileSync(FILE, 'utf8')) }; }
    catch (e) { console.error('[store] corrupt db.json, starting fresh:', e.message); }
  }
}

function save() {
  const snapshot = JSON.stringify(data, null, 2);
  writeChain = writeChain.then(async () => {
    const tmp = FILE + '.tmp';
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, FILE);
  }).catch((e) => console.error('[store] save failed:', e.message));
  return writeChain;
}

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const byNewest = (a, b) => (a.created_at < b.created_at ? 1 : -1);

// ── Greetings ─────────────────────────────────────────────────────────
export function listGreetings() {
  return [...data.greetings].sort(byNewest);
}
export function getGreeting(gid) {
  return data.greetings.find((g) => g.id === gid) || null;
}
export async function insertGreeting(row) {
  const g = { id: id(), created_at: now(), is_active: false, ...row };
  data.greetings.push(g);
  await save();
  return g;
}
export async function setActiveGreeting(gid) {
  let found = null;
  for (const g of data.greetings) {
    g.is_active = g.id === gid;
    if (g.is_active) found = g;
  }
  await save();
  return found;
}
export async function deleteGreeting(gid) {
  const idx = data.greetings.findIndex((g) => g.id === gid);
  if (idx === -1) return null;
  const [removed] = data.greetings.splice(idx, 1);
  await save();
  return removed;
}
export function getActiveGreeting() {
  return [...data.greetings].filter((g) => g.is_active).sort(byNewest)[0] || null;
}

// ── Campaigns ─────────────────────────────────────────────────────────
export function listCampaigns() {
  return [...data.campaigns].sort(byNewest);
}
export function getCampaign(cid) {
  return data.campaigns.find((c) => c.id === cid) || null;
}
export async function insertCampaign(row) {
  const c = { id: id(), created_at: now(), ...row };
  data.campaigns.push(c);
  await save();
  return c;
}
export async function updateCampaign(cid, patch) {
  const c = getCampaign(cid);
  if (!c) return null;
  Object.assign(c, patch);
  await save();
  return c;
}

// ── Campaign → number map ─────────────────────────────────────────────
export async function insertCampaignNumbers(rows) {
  for (const r of rows) data.campaign_numbers.push({ id: id(), created_at: now(), ...r });
  await save();
}
export function findGreetingUrlByNumberKey(key) {
  const match = data.campaign_numbers
    .filter((n) => n.number_key === key)
    .sort(byNewest)[0];
  return match?.greeting_url || null;
}

// ── Calls ─────────────────────────────────────────────────────────────
export function listCalls({ campaign, limit = 500 } = {}) {
  let rows = [...data.calls];
  if (campaign) rows = rows.filter((c) => c.exotel_campaign_id === String(campaign));
  return rows.sort((a, b) => (a.received_at < b.received_at ? 1 : -1)).slice(0, limit);
}
export async function upsertCall(row) {
  const rec = { received_at: now(), ...row };
  if (rec.call_sid) {
    const existing = data.calls.find((c) => c.call_sid === rec.call_sid);
    if (existing) { Object.assign(existing, rec); await save(); return existing; }
  }
  rec.id = id();
  data.calls.push(rec);
  await save();
  return rec;
}

// Bucket a raw Exotel call status into one of: completed | failed | pending |
// other. "failed" = worth retrying (busy, no-answer, failed, canceled…).
// Order matters: check failure first — "no-answer" contains "answer", so a
// naive success check would misfile it as completed.
const RETRY_RE = /(fail|busy|no[-_ ]?answer|cancel|declin|reject|missed|unreach)/i;
const SUCCESS_RE = /(complete|answer|success)/i;
const PENDING_RE = /(progress|ringing|queued|initiat|dial)/i;
export function classifyStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'other';
  if (RETRY_RE.test(s)) return 'failed';
  if (SUCCESS_RE.test(s)) return 'completed';
  if (PENDING_RE.test(s)) return 'pending';
  return 'other';
}

// Distinct recipient numbers whose most-recent call for this Exotel campaign
// failed (and did not later succeed). Used by "re-run failed calls".
export function failedNumbersForCampaign(exotelCampaignId) {
  const cid = String(exotelCampaignId);
  const latestByNumber = new Map(); // number_key → latest call row
  for (const c of data.calls) {
    if (c.exotel_campaign_id !== cid) continue;
    const key = String(c.to_number || '').replace(/\D/g, '').slice(-10);
    if (key.length !== 10) continue;
    const prev = latestByNumber.get(key);
    if (!prev || (c.received_at || '') > (prev.received_at || '')) latestByNumber.set(key, c);
  }
  const out = [];
  for (const c of latestByNumber.values()) {
    if (classifyStatus(c.status) === 'failed') out.push(c.to_number);
  }
  return out;
}
