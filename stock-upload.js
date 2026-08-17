import { db, doc, setDoc, getDoc, serverTimestamp } from './firebase-init.js';

// Expects the "UID Distributor Stock Report" template:
// Row 1: PCODE | NAMA BARANG | ISI | Gudang Utama | (blank) | (blank)
// Row 2: (blank) | (blank) | (blank) | Karton | Lusin | PCs
// Row 3+: data rows
export function parseDistributorWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames.find(n => n.toLowerCase() !== 'selected parameters') || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const items = {};
  let skipped = 0;
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[0] == null) continue;
    const pcode = String(row[0]).trim();
    const namaBarang = row[1] != null ? String(row[1]).trim() : '';
    const isi = row[2] != null ? Number(row[2]) : null;
    const karton = row[3] != null ? Number(row[3]) : 0;
    const lusin = row[4] != null ? Number(row[4]) : 0;
    const pcs = row[5] != null ? Number(row[5]) : 0;
    if (!pcode) { skipped++; continue; }
    items[pcode] = { namaBarang, isi, karton, lusin, pcs };
  }
  return { items, rowCount: Object.keys(items).length, skipped };
}

export async function saveDistributorStock(area, items, sourceFileName) {
  const ref = doc(db, 'distributorStock', area);
  await setDoc(ref, {
    area,
    items,
    sourceFileName: sourceFileName || null,
    uploadedAt: serverTimestamp()
  });
}

export async function loadDistributorStock(area) {
  const ref = doc(db, 'distributorStock', area);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}
