// Parsing file SKU Promo (misal export "Consumer Promo Detail Mekanisme") untuk fitur
// upload SKU Promo per Channel. Header dicocokkan by NAMA kolom (bukan posisi tetap),
// supaya tidak gampang rusak kalau urutan kolom berubah tiap bulan.
// Kolom yang dicari: barcode, sku code mapping (PC Code), sku description current
// (atau product name), rsp. Kolom lain diabaikan.

const HEADER_ALIASES = {
  barcode: ['barcode'],
  pcode: ['sku code mapping', 'pcode', 'pc code'],
  name: ['sku description current', 'sku description', 'product name', 'nama produk'],
  rsp: ['rsp']
};

function findColumn(header, aliases) {
  for (const alias of aliases) {
    const idx = header.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parsePromoWorkbook(arrayBuffer) {
  const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
  // Kalau ada sheet bernama "Detail Mekanisme" pakai itu, kalau tidak pakai sheet pertama.
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('mekanisme')) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!rows.length) return { items: [], headerMissing: true };

  // Header bisa ada di baris 1 ATAU baris 2 (file Consumer Promo asli headernya di baris 2).
  let headerRowIdx = -1;
  let idx = {};
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const header = (rows[r] || []).map(h => (h == null ? '' : String(h).trim().toLowerCase()));
    const tryIdx = {
      barcode: findColumn(header, HEADER_ALIASES.barcode),
      pcode: findColumn(header, HEADER_ALIASES.pcode),
      name: findColumn(header, HEADER_ALIASES.name),
      rsp: findColumn(header, HEADER_ALIASES.rsp)
    };
    if (tryIdx.pcode !== -1 && tryIdx.name !== -1) {
      headerRowIdx = r;
      idx = tryIdx;
      break;
    }
  }
  if (headerRowIdx === -1) return { items: [], headerMissing: true };

  const items = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[idx.pcode] == null) continue;
    const pcode = String(row[idx.pcode]).trim();
    const name = idx.name !== -1 && row[idx.name] != null ? String(row[idx.name]).trim() : '';
    const barcode = idx.barcode !== -1 && row[idx.barcode] != null ? String(row[idx.barcode]).trim() : null;
    const rsp = idx.rsp !== -1 && row[idx.rsp] != null ? Number(row[idx.rsp]) : null;
    if (!pcode || !name) continue;
    items.push({ pcode, name, barcode, rsp: isNaN(rsp) ? null : rsp });
  }

  // Dedupe by pcode (file promo biasanya ada baris duplikat per fase/tanggal)
  const byPcode = {};
  for (const it of items) byPcode[it.pcode] = it;

  return { items: Object.values(byPcode), headerMissing: false };
}
