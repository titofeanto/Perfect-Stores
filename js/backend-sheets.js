// Pengganti Firestore yang berbicara ke Google Sheets (lewat Apps Script Web App).
// API-nya SAMA dengan yang dipakai aplikasi (doc, getDoc, setDoc, collection, query, where, getDocs,
// serverTimestamp, .toDate()), jadi logika aplikasi tidak perlu diubah.
//
// Catatan desain:
//  - Tiap panggilan = 1 request ke Apps Script (sekitar 0,5-2 detik). Karena itu setDoc(merge) untuk dokumen
//    yang sama DIGABUNG dulu di HP selama BATCH_MS lalu dikirim sekali (autosave per SKU tidak membanjiri Sheets).
//  - Sebelum membaca, penulisan yang tertunda di-flush dulu supaya hasil tulis langsung terbaca.
//  - Request memakai Content-Type text/plain agar tidak memicu preflight CORS (Apps Script tidak menjawab OPTIONS).
import { BACKEND } from '../backend-config.js';

const BATCH_MS = 800;
const TIMEOUT_MS = 40000;

export const db = { backend: 'sheets' };
export const authReady = Promise.resolve();

function backendError(message, code) {
  const e = new Error(message);
  e.code = code || 'sheets/error';
  return e;
}

async function call(body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BACKEND.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: BACKEND.token, ...body }),
      signal: ctl.signal
    });
  } catch (err) {
    throw backendError(err.name === 'AbortError' ? 'Backend Sheets terlalu lama merespons.' : 'Tidak bisa terhubung ke backend Sheets.', 'sheets/network');
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = await res.json(); } catch (e) { throw backendError('Respons backend bukan JSON (URL Web App salah atau belum di-deploy?).', 'sheets/bad-response'); }
  if (!json.ok) throw backendError(json.error || 'Backend menolak permintaan.', 'sheets/rejected');
  return json;
}

// ---------- referensi (mirip Firestore) ----------
export const collection = (_db, name) => ({ kind: 'collection', name });
export const doc = (_db, name, id) => ({ kind: 'doc', name, id: String(id), key: name + '/' + id });
export const serverTimestamp = () => ({ __sentinel: 'serverTimestamp' });
export const where = (field, op, value) => {
  if (op !== '==') throw backendError('Hanya operator == yang didukung.');
  return { field, value };
};
export const query = (col, w) => ({ kind: 'query', name: col.name, where: w });

// ---------- timestamp: {__ts: ISO} -> objek dengan .toDate() ----------
function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    if (typeof v.__ts === 'string') {
      const d = new Date(v.__ts);
      return { seconds: Math.floor(d.getTime() / 1000), toDate: () => new Date(d.getTime()), toMillis: () => d.getTime(), __ts: v.__ts };
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = revive(v[k]);
    return o;
  }
  return v;
}

const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    const s = src[k];
    if (isPlain(s) && s.__sentinel === undefined && isPlain(target[k]) && target[k].__sentinel === undefined) deepMerge(target[k], s);
    else target[k] = isPlain(s) ? JSON.parse(JSON.stringify(s)) : s;
  }
  return target;
}
// Nilai `undefined` (yang dibuang JSON) dibersihkan dulu, sama seperti perilaku kirim JSON ke Firestore.
const clean = (data) => JSON.parse(JSON.stringify(data));

// ---------- antrean tulis ----------
const pending = new Map();   // key -> { ref, data, waiters, timer }
const chains = new Map();    // key -> promise berantai (urutan kirim per dokumen dijaga)

function send(key, ref, data, merge) {
  const run = () => call({ action: 'setDoc', collection: ref.name, id: ref.id, data, merge });
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  chains.set(key, next);
  return next;
}

async function flushKey(key) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  clearTimeout(p.timer);
  try {
    await send(key, p.ref, p.data, true);
    p.waiters.forEach(w => w.resolve());
  } catch (err) {
    p.waiters.forEach(w => w.reject(err));
  }
}

async function flushAll() {
  await Promise.all([...pending.keys()].map(flushKey));
  await Promise.all([...chains.values()].map(p => p.catch(() => {})));
}

export function setDoc(ref, data, options) {
  const merge = !!(options && options.merge);
  const payload = clean(data);
  if (!merge) {
    // Ganti seluruh dokumen (mis. stock distributor): kirim penulisan tertunda dulu, lalu timpa.
    return flushKey(ref.key).then(() => send(ref.key, ref, payload, false)).then(() => undefined);
  }
  return new Promise((resolve, reject) => {
    let p = pending.get(ref.key);
    if (!p) { p = { ref, data: {}, waiters: [], timer: null }; pending.set(ref.key, p); }
    deepMerge(p.data, payload);
    p.waiters.push({ resolve, reject });
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flushKey(ref.key), BATCH_MS);
  });
}

if (typeof window !== 'undefined') {
  // Jangan kehilangan isian terakhir saat tab ditutup/di-background.
  window.addEventListener('pagehide', () => { for (const k of [...pending.keys()]) flushKey(k); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') for (const k of [...pending.keys()]) flushKey(k); });
}

// ---------- baca ----------
const makeSnap = (d) => ({ id: d.id, exists: () => true, data: () => revive(d.data) });

export async function getDoc(ref) {
  await flushAll();
  const r = await call({ action: 'getDoc', collection: ref.name, id: ref.id });
  if (!r.doc) return { id: ref.id, exists: () => false, data: () => undefined };
  return makeSnap(r.doc);
}

export async function getDocs(q) {
  await flushAll();
  const r = await call({ action: 'query', collection: q.name, field: q.where.field, value: q.where.value });
  const docs = (r.docs || []).map(makeSnap);
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
}
