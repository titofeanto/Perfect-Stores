// Data master (toko, SKU wajib + SKU Code, mapping akun). Sumber: Google Sheets bila diaktifkan di
// backend-config.js, dengan tiga lapis cadangan supaya aplikasi tidak pernah kosong:
//   1) salinan segar di HP (kurang dari masterFreshMs)  -> langsung, tanpa jaringan
//   2) Google Sheets                                     -> lalu disimpan sebagai salinan di HP
//   3) salinan terakhir di HP (sudah lama), lalu file JSON di repo (dikembalikan null -> pemanggil pakai file)
import { BACKEND } from '../backend-config.js';

const CACHE_KEY = 'sba_master_v1';
let inflight = null;

export function masterEnabled() {
  return BACKEND.master === 'sheets' && !!BACKEND.endpoint;
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) { /* penyimpanan penuh/diblokir: abaikan */ }
}
function looksValid(d) {
  return d && Array.isArray(d.stores) && d.stores.length > 0 && d.skus && typeof d.skus === 'object';
}

async function fetchFromSheets() {
  const url = `${BACKEND.endpoint}?action=master&token=${encodeURIComponent(BACKEND.token)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BACKEND.masterTimeoutMs || 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Backend menolak permintaan master.');
    if (!looksValid(json.data)) throw new Error('Data master dari Sheets kosong atau formatnya salah (cek tab Toko dan SKU_Wajib).');
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

// Mengembalikan {stores, skus, mapping} atau null (pemanggil lalu memakai file JSON di repo).
export function loadMaster() {
  if (!masterEnabled()) return Promise.resolve(null);
  if (!inflight) {
    inflight = (async () => {
      const cached = readCache();
      if (cached && looksValid(cached.data) && Date.now() - cached.ts < (BACKEND.masterFreshMs || 90000)) return cached.data;
      try {
        const data = await fetchFromSheets();
        writeCache(data);
        return data;
      } catch (err) {
        console.warn('Master dari Google Sheets gagal dimuat, memakai cadangan:', err);
        if (cached && looksValid(cached.data)) return cached.data;
        return null;
      }
    })();
  }
  return inflight;
}
