import { loadMaster } from './master-data.js';

// Daftar toko + SKU wajib berversi (lihat scripts/build_versions.py dan halaman versi.html).
//   data/versions.json      daftar versi: id, label, effectiveFrom (tanggal berlaku), updatedAt, ringkasan perubahan
//   data/ver/<id>.json      stores, skus (per scope), sets + storeSet (daftar SKU tiap toko)
//
// Aturan memilih versi untuk satu toko pada satu minggu (resolveListVersion):
//   1. Entry sudah punya listVersion  -> pakai versi itu (dicatat saat pertama kali disimpan).
//   2. Entry lama berisi data tapi belum punya listVersion (diisi sebelum sistem versi) -> versi paling awal.
//   3. Selain itu (belum ada entry / masih kosong) -> versi terbaru yang tanggal berlakunya <= Senin minggu itu.
// Jadi saat daftar berubah, data yang sudah terisi tidak ikut berubah; hanya yang masih kosong memakai daftar baru.

const SKU_FILES = {
  'lmt-spm': 'data/sku-lmt-spm.json',
  'local-minis': 'data/sku-local-minis.json',
  'haba-dt': 'data/sku-haba-dt.json'
};

let hargaProdukCache = null;
let metaPromise = null;
const versionPromises = {};
const storeListCache = {};

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Mode Google Sheets (BACKEND.master = 'sheets'): master datang dari Sheet dan tidak berversi -> 1 versi sintetis.
async function syntheticVersion(master) {
  const skus = {};
  for (const [slug, list] of Object.entries(master.skus)) skus[slug] = list;
  const sets = {}, storeSet = {};
  for (const slug of Object.keys(skus)) sets['scope-' + slug] = Object.fromEntries(skus[slug].map(s => [s.barcode, s.flag || 'COTC']));
  for (const st of master.stores) storeSet[st.id] = 'scope-' + st.scopeSlug;
  return { id: 'v1', stores: master.stores, skus, sets, storeSet };
}

export function loadVersionsMeta() {
  if (!metaPromise) {
    metaPromise = (async () => {
      const master = await loadMaster();
      if (master) {
        versionPromises.v1 = syntheticVersion(master);
        return { versions: [{ id: 'v1', label: 'Master dari Google Sheets', effectiveFrom: '2000-01-01', updatedAt: '', summary: {}, changes: {} }], synthetic: true };
      }
      const res = await fetch('data/versions.json');
      const meta = await res.json();
      meta.versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      return meta;
    })();
  }
  return metaPromise;
}

export async function loadVersion(id) {
  const meta = await loadVersionsMeta();
  if (!versionPromises[id]) {
    const v = meta.versions.find(x => x.id === id);
    if (!v) throw new Error('Versi daftar SKU tidak dikenal: ' + id);
    versionPromises[id] = fetch(v.file).then(r => r.json());
  }
  return versionPromises[id];
}

export async function loadAllVersions() {
  const meta = await loadVersionsMeta();
  const loaded = await Promise.all(meta.versions.map(v => loadVersion(v.id)));
  return { meta, versions: Object.fromEntries(loaded.map(v => [v.id, v])) };
}

// Versi yang berlaku untuk minggu dengan periodKey (YYYY-MM-DD, tanggal Senin) bila belum ada data.
export function versionIdForPeriod(meta, periodKey) {
  let chosen = meta.versions[0].id;
  for (const v of meta.versions) if (v.effectiveFrom <= periodKey) chosen = v.id;
  return chosen;
}

function fieldFilled(f) {
  if (f == null) return false;
  if (typeof f === 'object') return ['karton', 'lusin', 'pcs'].some(k => f[k] !== '' && f[k] != null);
  return String(f) !== '';
}

export function entryHasData(entry) {
  if (!entry || !entry.items) return false;
  return Object.values(entry.items).some(it => it && ['stock', 'order', 'masuk', 'jual'].some(k => fieldFilled(it[k])));
}

export function resolveListVersion(meta, entry, periodKey) {
  if (entry && entry.listVersion && meta.versions.some(v => v.id === entry.listVersion)) return entry.listVersion;
  if (entryHasData(entry)) return meta.versions[0].id;
  return versionIdForPeriod(meta, periodKey);
}

// Daftar SKU wajib 1 toko di 1 versi, dengan flag khusus toko itu (satu barcode bisa COTC di toko A, NPD di toko B).
export function skuListForStore(version, store) {
  const setId = version.storeSet[store.id];
  const key = `${version.id}|${setId || store.scopeSlug}|${store.scopeSlug}`;
  if (storeListCache[key]) return storeListCache[key];
  const scopeList = version.skus[store.scopeSlug] || [];
  const set = setId ? version.sets[setId] : null;
  const list = set
    ? scopeList.filter(s => set[s.barcode]).map(s => (set[s.barcode] === s.flag ? s : { ...s, flag: set[s.barcode] }))
    : scopeList;
  storeListCache[key] = list;
  return list;
}

// Versi yang sedang berlaku hari ini (dipakai untuk daftar toko di halaman input dan sebagai daftar SKU bawaan).
export async function currentVersion() {
  const meta = await loadVersionsMeta();
  return loadVersion(versionIdForPeriod(meta, today()));
}

// Toko yang dimonitor SEKARANG (versi yang berlaku hari ini).
export async function loadStores() {
  return (await currentVersion()).stores;
}

// Gabungan toko dari semua versi (info toko terbaru yang dipakai), untuk dashboard minggu-minggu lama.
export async function loadAllStores() {
  const { meta, versions } = await loadAllVersions();
  const byId = new Map();
  for (const v of meta.versions) for (const st of versions[v.id].stores) byId.set(st.id, st);
  return [...byId.values()];
}

// Daftar SKU wajib satu scope pada versi yang berlaku hari ini (gabungan semua toko di scope itu).
export async function loadSkuList(scopeSlug) {
  const v = await currentVersion();
  if (v.skus[scopeSlug]) return v.skus[scopeSlug];
  const path = SKU_FILES[scopeSlug];
  if (!path) throw new Error('Scope channel tidak dikenal: ' + scopeSlug);
  const res = await fetch(path);
  return res.json();
}

// Daftar produk untuk survei harga: gabungan SKU wajib LMT SPM (dengan flag) + SKU
// dari file promo Consumer Promo (tanpa flag, punya RSP). Lihat scripts/build_data.py
// bagian build_harga_produk untuk cara regenerate.
export async function loadHargaProduk() {
  if (hargaProdukCache) return hargaProdukCache;
  const res = await fetch('data/harga-produk.json');
  hargaProdukCache = await res.json();
  return hargaProdukCache;
}

export function groupStoresByArea(stores) {
  const byArea = {};
  for (const s of stores) {
    if (!byArea[s.area]) byArea[s.area] = [];
    byArea[s.area].push(s);
  }
  return byArea;
}
