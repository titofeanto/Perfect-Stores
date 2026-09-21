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
  const meta = { reportDate: null, distributorName: null };
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
      const m = typeof c === 'string' ? c.match(/^\d+~(.+)$/) : null;
      if (m && !meta.distributorName) meta.distributorName = m[1].trim();
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
// termasuk seluruh isi `items`. Produk yang tidak ada di file baru ikut hilang; tidak ada stock lama
// yang tersisa atau dijumlahkan. Stock bergerak tiap hari, jadi yang disimpan hanya snapshot terakhir.
export async function saveDistributorStock(area, items, sourceFileName, meta = {}) {
  const ref = doc(db, 'distributorStock', area);
  await setDoc(ref, {
    area,
    items,
    sourceFileName: sourceFileName || null,
    reportDate: meta.reportDate || null,
    distributorName: meta.distributorName || null,
    uploadedAt: serverTimestamp()
  });
}

export async function loadDistributorStock(area) {
  const ref = doc(db, 'distributorStock', area);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}
