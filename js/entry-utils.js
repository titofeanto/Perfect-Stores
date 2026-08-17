// Logic bersama untuk status kelengkapan SKU wajib -- dipakai oleh app.js (input per toko)
// dan dashboard.js (rekap lintas toko), supaya definisi "lengkap/belum lengkap" selalu sama.

export const FIELDS = ['stock', 'order', 'masuk', 'jual'];

// SBA hanya mengisi Stock & Order. Masuk (barang masuk) diisi lewat upload data
// pembelian toko oleh Supervisor, dan Jual dihitung otomatis dari rumus
// (Stock minggu lalu + Masuk minggu ini - Stock minggu ini). Kelengkapan isian
// SBA jadi hanya berdasarkan 2 field ini, bukan 4.
export const EDITABLE_FIELDS = ['stock', 'order'];

// Satu sub-field {karton, lusin, pcs} -> total pcs. 1 lusin selalu = 12 pcs.
// Karton dikonversi pakai sku.isi (pcs per karton); kalau isi tidak diketahui, karton diabaikan.
export function fieldTotal(f, isi) {
  const karton = f.karton === '' || f.karton == null ? 0 : Number(f.karton) || 0;
  const lusin = f.lusin === '' || f.lusin == null ? 0 : Number(f.lusin) || 0;
  const pcs = f.pcs === '' || f.pcs == null ? 0 : Number(f.pcs) || 0;
  return karton * (isi || 0) + lusin * 12 + pcs;
}

export function fieldIsEmpty(f) {
  if (!f) return true;
  return (!f.karton || f.karton === '') && (!f.lusin || f.lusin === '') && (!f.pcs || f.pcs === '');
}

// Data lama (sebelum fitur karton/lusin/pcs) tersimpan sebagai angka pcs polos.
export function normalizeField(raw) {
  if (raw && typeof raw === 'object' && ('karton' in raw || 'lusin' in raw || 'pcs' in raw)) {
    return { karton: raw.karton ?? '', lusin: raw.lusin ?? '', pcs: raw.pcs ?? '' };
  }
  if (raw !== undefined && raw !== null && raw !== '') {
    return { karton: '', lusin: '', pcs: String(raw) };
  }
  return { karton: '', lusin: '', pcs: '' };
}

export function statusOf(item) {
  const filled = EDITABLE_FIELDS.filter(f => !fieldIsEmpty(item[f])).length;
  if (filled === EDITABLE_FIELDS.length) return 'lengkap';
  if (filled === 0) return 'kosong';
  return 'partial';
}

// Daftar SKU yang stock tokonya 0, dicocokkan dengan stock distributor (kalau ada
// datanya) -- dipakai dashboard untuk drill-down "Tidak ada" per toko.
// distStockItems: map {pcode: {karton,lusin,pcs}} dari koleksi distributorStock/{area}.
// CATATAN: distributorStock cuma menyimpan snapshot TERBARU (bukan histori per minggu),
// jadi kalau minggu yang dilihat bukan minggu berjalan, angka DT ini adalah kondisi
// TERKINI, bukan kondisi persis pada minggu itu.
export function buildOosDetail(items, skuList, distStockItems) {
  items = items || {};
  distStockItems = distStockItems || {};
  const result = [];
  for (const sku of skuList) {
    const raw = items[sku.barcode] || {};
    const stockField = normalizeField(raw.stock);
    if (fieldIsEmpty(stockField)) continue;
    const qty = fieldTotal(stockField, sku.isi);
    if (qty !== 0) continue;
    const dt = sku.pcode ? distStockItems[sku.pcode] : null;
    let dtQty = null;
    if (dt) {
      dtQty = (Number(dt.karton) || 0) * (sku.isi || 0) + (Number(dt.lusin) || 0) * 12 + (Number(dt.pcs) || 0);
    }
    result.push({
      barcode: sku.barcode,
      pcode: sku.pcode,
      name: sku.name,
      flag: sku.flag,
      dtQty, // null = tidak ada data DT sama sekali, angka (termasuk 0) = ada datanya
    });
  }
  return result;
}

// Ringkas 1 dokumen entry (hasil isian 1 toko utk 1 minggu) terhadap 1 daftar SKU wajib.
// items: map {barcode: {stock,order,masuk,jual}} dari Firestore (bisa format lama/baru/kosong).
// skuList: array SKU wajib toko itu (dari data/sku-*.json).
// byFlag: breakdown ketersediaan (stock > 0) per flag COTC/MARKET MAKING/NPD -- dipakai
// dashboard untuk persentase "barang yang terdapat di toko" per kategori.
export function summarizeEntry(items, skuList) {
  items = items || {};
  let lengkap = 0;
  let tidakAda = 0;
  let ada = 0;
  const byFlag = {};
  for (const sku of skuList) {
    const raw = items[sku.barcode] || {};
    const entryItem = {};
    for (const f of FIELDS) entryItem[f] = normalizeField(raw[f]);
    if (statusOf(entryItem) === 'lengkap') lengkap++;

    const stockFilled = !fieldIsEmpty(entryItem.stock);
    const stockQty = stockFilled ? fieldTotal(entryItem.stock, sku.isi) : null;
    const isTidakAda = stockFilled && stockQty === 0;
    const isAda = stockFilled && stockQty > 0;
    if (isTidakAda) tidakAda++;
    if (isAda) ada++;

    const flag = sku.flag || 'COTC';
    if (!byFlag[flag]) byFlag[flag] = { total: 0, ada: 0, tidakAda: 0, belumIsi: 0 };
    byFlag[flag].total++;
    if (isAda) byFlag[flag].ada++;
    else if (isTidakAda) byFlag[flag].tidakAda++;
    else byFlag[flag].belumIsi++;
  }
  return {
    total: skuList.length,
    lengkap,
    belum: skuList.length - lengkap,
    tidakAda,
    ada,
    // OSA (On Shelf Availability) = SKU dengan stock > 0 dibagi total SKU wajib.
    osaPct: skuList.length ? Math.round((ada / skuList.length) * 100) : 0,
    pct: skuList.length ? Math.round((lengkap / skuList.length) * 100) : 0,
    byFlag
  };
}
