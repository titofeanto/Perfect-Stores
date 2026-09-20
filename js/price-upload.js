// Parsing file upload harga manual (Excel) untuk 1 toko + 1 bulan yang sedang dipilih
// di halaman Survei Harga. Formatnya sengaja dibuat SAMA dengan hasil "Export toko ini" /
// "Export semua toko", supaya bisa export -> edit di Excel -> upload balik (round-trip).
// Header dicocokkan by NAMA kolom, bukan posisi tetap.
//
// Kunci utama pencocokan produk = BARCODE (bukan PC Code): data harga dari toko
// biasanya per barcode/varian. PCCode tetap dibaca kalau ada, sebagai fallback untuk
// baris yang tidak punya kolom Barcode.

const HEADER_ALIASES = {
  toko: ['toko'],
  barcode: ['barcode'],
  pcode: ['pccode', 'pc code', 'pcode'],
  nama: ['namaproduk', 'nama produk'],
  jenis: ['jenisharga', 'jenis harga'],
  kompetitor: ['namakompetitor', 'nama kompetitor'],
  harga: ['harga']
};

function findColumn(header, aliases) {
  for (const alias of aliases) {
    const idx = header.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parsePriceWorkbook(arrayBuffer) {
  const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!rows.length) return { rows: [], headerMissing: true };

  let headerRowIdx = -1;
  let idx = {};
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const header = (rows[r] || []).map(h => (h == null ? '' : String(h).trim().toLowerCase()));
    const tryIdx = {
      toko: findColumn(header, HEADER_ALIASES.toko),
      barcode: findColumn(header, HEADER_ALIASES.barcode),
      pcode: findColumn(header, HEADER_ALIASES.pcode),
      nama: findColumn(header, HEADER_ALIASES.nama),
      jenis: findColumn(header, HEADER_ALIASES.jenis),
      kompetitor: findColumn(header, HEADER_ALIASES.kompetitor),
      harga: findColumn(header, HEADER_ALIASES.harga)
    };
    if ((tryIdx.barcode !== -1 || tryIdx.pcode !== -1) && tryIdx.harga !== -1) {
      headerRowIdx = r;
      idx = tryIdx;
      break;
    }
  }
  if (headerRowIdx === -1) return { rows: [], headerMissing: true };

  const parsed = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const barcode = idx.barcode !== -1 && row[idx.barcode] != null ? String(row[idx.barcode]).trim() : null;
    const pcode = idx.pcode !== -1 && row[idx.pcode] != null ? String(row[idx.pcode]).trim() : null;
    if (!barcode && !pcode) continue;
    const harga = row[idx.harga] != null ? Number(row[idx.harga]) : null;
    if (harga === null || isNaN(harga)) continue;
    const jenisRaw = idx.jenis !== -1 && row[idx.jenis] != null ? String(row[idx.jenis]).trim().toLowerCase() : 'unilever';
    const jenis = jenisRaw.startsWith('komp') ? 'kompetitor' : 'unilever';
    const namaKompetitor = idx.kompetitor !== -1 && row[idx.kompetitor] != null ? String(row[idx.kompetitor]).trim() : '';
    const namaProduk = idx.nama !== -1 && row[idx.nama] != null ? String(row[idx.nama]).trim() : '';
    const toko = idx.toko !== -1 && row[idx.toko] != null ? String(row[idx.toko]).trim() : null;
    parsed.push({ toko, barcode, pcode, namaProduk, jenis, namaKompetitor, harga });
  }
  return { rows: parsed, headerMissing: false };
}
