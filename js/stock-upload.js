import { db, doc, setDoc, getDoc, serverTimestamp } from './firebase-init.js';

// Membaca laporan "UID Distributor Stock Report" (atau template aplikasi) SECARA BERDASARKAN NAMA KOLOM,
// bukan posisi tetap. Laporan asli punya kolom ekstra "ON CUST.ORDER" sebelum "Gudang Utama"; kalau
// posisi kolom dianggap tetap, Karton/Lusin/PCs terbaca bergeser satu kolom (stock salah, bisa
// membengkak puluhan kali lipat). Struktur yang dicari:
//   baris header : PCODE | Nama Barang | Isi Per Karton ... | (kolom lain) | Gudang Utama ...
//   baris sub    : ... | Karton | Lusin | PCs
//   baris data   : setelah baris sub
const up = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toUpperCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function excelSerialToIso(serial) {
  const d = XLSX.SSF.parse_date_code(serial);
  if (!d) return null;
  return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
}

// Tanggal laporan + nama distributor ada di sheet "Selected Parameters" (kalau ada).
function readReportMeta(wb) {
  const name = wb.SheetNames.find(n => n.toLowerCase() === 'selected parameters');
  const meta = { reportDate: null, distributorName: null, distributorCode: null };
  if (!name) return meta;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
  for (const r of rows) {
    if (!r) continue;
    const i = r.findIndex(c => up(c) === 'TANGGAL:');
    if (i !== -1 && !meta.reportDate) {
      const serial = r.slice(i + 1).find(c => typeof c === 'number' && c > 30000 && c < 80000);
      if (serial) meta.reportDate = excelSerialToIso(serial);
    }
    for (const c of r) {
      const m = typeof c === 'string' ? c.match(/^(\d+)~(.+)$/) : null;
      if (m && !meta.distributorName) { meta.distributorName = m[2].trim(); meta.distributorCode = m[1]; }
    }
  }
  return meta;
}

export function parseDistributorWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames.find(n => n.toLowerCase() !== 'selected parameters') || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const headerRow = rows.findIndex(r => r && r.some(c => up(c) === 'PCODE'));
  if (headerRow === -1) throw new Error('Kolom PCODE tidak ditemukan.');
  const hdr = rows[headerRow];
  const cPcode = hdr.findIndex(c => up(c) === 'PCODE');
  let cName = hdr.findIndex(c => up(c) === 'NAMA BARANG');
  if (cName === -1) cName = cPcode + 1;
  const cIsi = hdr.findIndex(c => up(c).startsWith('ISI'));

  let subRow = -1, cKarton = -1, cLusin = -1, cPcs = -1;
  for (let r = headerRow; r <= headerRow + 3 && r < rows.length; r++) {
    const row = rows[r] || [];
    const k = row.findIndex(c => up(c) === 'KARTON');
    const l = row.findIndex(c => up(c) === 'LUSIN');
    const p = row.findIndex(c => up(c) === 'PCS');
    if (k !== -1 && l !== -1 && p !== -1) { subRow = r; cKarton = k; cLusin = l; cPcs = p; break; }
  }
  if (subRow === -1) throw new Error('Kolom Karton / Lusin / PCs tidak ditemukan.');

  // Satu PCODE = satu baris di laporan. Kalau (jarang) ada PCODE ganda, yang terakhir dipakai
  // dan dihitung di `duplicates` -- TIDAK dijumlahkan, supaya stock tidak menggelembung.
  const items = {};
  let skipped = 0;
  let duplicates = 0;
  for (let r = subRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[cPcode] == null || String(row[cPcode]).trim() === '') continue;
    const pcode = String(row[cPcode]).trim();
    if (items[pcode]) duplicates++;
    items[pcode] = {
      namaBarang: row[cName] != null ? String(row[cName]).trim() : '',
      isi: cIsi !== -1 && row[cIsi] != null ? num(row[cIsi]) : null,
      karton: num(row[cKarton]),
      lusin: num(row[cLusin]),
      pcs: num(row[cPcs]),
    };
  }
  const meta = readReportMeta(wb);
  return { items, rowCount: Object.keys(items).length, skipped, duplicates, ...meta };
}

export function formatReportDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Unggahan baru MENIMPA seluruh dokumen area ini: setDoc tanpa { merge: true } mengganti semua field,
// termasuk seluruh isi stock. Produk yang tidak ada di file baru ikut hilang; tidak ada stock lama
// yang tersisa atau dijumlahkan. Stock bergerak tiap hari, jadi yang disimpan hanya snapshot terakhir.
//
// Stock disimpan sebagai SATU string JSON (`itemsJson`), bukan map bersarang. Firestore membuat index
// untuk setiap sub-field map, dan batasnya 40.000 index entry per dokumen: laporan ~3.600 produk x 5
// field sudah melewati batas itu dan simpan gagal. String panjang hanya jadi 1 index entry.
// Format ringkas: { pcode: [karton, lusin, pcs, isi] }. Dokumen lama (field `items`) tetap terbaca.
function packItems(items) {
  const out = {};
  for (const [code, it] of Object.entries(items)) out[code] = [it.karton || 0, it.lusin || 0, it.pcs || 0, it.isi || 0];
  return JSON.stringify(out);
}

// Ubah dokumen Firestore ke bentuk yang dipakai app: data.items = { pcode: {karton, lusin, pcs, isi} }.
export function decodeDistributorDoc(data) {
  if (!data) return null;
  if (data.itemsJson) {
    const packed = JSON.parse(data.itemsJson);
    const items = {};
    for (const [code, a] of Object.entries(packed)) items[code] = { karton: a[0], lusin: a[1], pcs: a[2], isi: a[3] || null };
    return { ...data, items };
  }
  return data;
}

// ---------- Tujuan stock: area + distributor ----------
// Satu area bisa dilayani lebih dari satu distributor (mis. Jayapura, Timika). Data toko membawa
// `distributor` berformat "kode-nama" ("15261006-CV AMAN JAYA ANUGRAH ABEPURA"). Stock disimpan per
// distributor di dokumen `distributorStock/{area}__{kode}`; toko tanpa data distributor memakai
// dokumen lama `distributorStock/{area}`.
export function distCodeOf(store) {
  const d = store && store.distributor ? String(store.distributor) : '';
  const i = d.indexOf('-');
  return i > 0 ? d.slice(0, i).trim() : '';
}
export function distNameOf(store) {
  const d = store && store.distributor ? String(store.distributor) : '';
  const i = d.indexOf('-');
  return i > 0 ? d.slice(i + 1).trim() : d.trim();
}
export const stockKey = (area, distCode) => (distCode ? `${area}__${distCode}` : area);
export const stockKeyOf = (store) => stockKey(store.area, distCodeOf(store));

const normName = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
// Nama di laporan distributor sering sedikit beda (singkatan, tanda baca) dari nama di daftar toko.
export function sameDistributor(a, b) {
  const x = normName(a), y = normName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export async function saveDistributorStock(area, dist, items, sourceFileName, meta = {}) {
  const key = stockKey(area, dist && dist.code);
  const ref = doc(db, 'distributorStock', key);
  await setDoc(ref, {
    area,
    distributorCode: (dist && dist.code) || null,
    distributorTarget: (dist && dist.name) || null,
    itemsJson: packItems(items),
    itemCount: Object.keys(items).length,
    sourceFileName: sourceFileName || null,
    reportDate: meta.reportDate || null,
    distributorName: meta.distributorName || null,
    uploadedAt: serverTimestamp()
  });
  return key;
}

// Muat stock untuk satu area + distributor. Dokumen lama per area hanya dipakai kalau nama distributor
// di dalamnya cocok, supaya stock distributor lain di area yang sama tidak salah terbaca.
export async function loadDistributorStock(area, dist) {
  if (dist && dist.code) {
    const snap = await getDoc(doc(db, 'distributorStock', stockKey(area, dist.code)));
    if (snap.exists()) return decodeDistributorDoc(snap.data());
    const legacy = await getDoc(doc(db, 'distributorStock', area));
    if (legacy.exists()) {
      const d = decodeDistributorDoc(legacy.data());
      if (!d.distributorName || sameDistributor(d.distributorName, dist.name)) return d;
    }
    return null;
  }
  const snap = await getDoc(doc(db, 'distributorStock', area));
  return snap.exists() ? decodeDistributorDoc(snap.data()) : null;
}
