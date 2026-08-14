// Parsing file "Upload Extract Penjualan" (pembelian toko dari distributor).
// Kolom yang dipakai cuma: Outlet (=storeId), SKUCode (=PC Code), TotalQuantity(PCS), INVDate.
// Kolom lain (harga, GSV, diskon, pajak, dst) diabaikan sepenuhnya -- tidak pernah disimpan.

function parseInvDate(raw) {
  if (raw instanceof Date && !isNaN(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  if (typeof raw === 'number' && window.XLSX && window.XLSX.SSF) {
    try {
      const d = window.XLSX.SSF.parse_date_code(raw);
      return new Date(d.y, d.m - 1, d.d);
    } catch (e) { /* abaikan, dianggap tanggal tidak valid */ }
  }
  return null;
}

// Mengembalikan daftar baris mentah {outlet, skuCode, qty, invDate} -- belum
// dicocokkan ke toko/SKU wajib, itu dilakukan di app.js karena butuh akses ke
// daftar toko & SKU wajib yang sudah dimuat.
export function parsePurchaseWorkbook(arrayBuffer) {
  const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  if (!rows.length) return { rows: [], headerMissing: true };

  const header = rows[0].map(h => (h == null ? '' : String(h).trim().toLowerCase()));
  const idx = {
    outlet: header.indexOf('outlet'),
    skuCode: header.indexOf('skucode'),
    qty: header.indexOf('totalquantity(pcs)'),
    invDate: header.indexOf('invdate')
  };
  if (idx.outlet === -1 || idx.skuCode === -1 || idx.qty === -1) {
    return { rows: [], headerMissing: true };
  }

  const parsed = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[idx.outlet] == null) continue;
    const outlet = String(row[idx.outlet]).trim();
    const skuCode = row[idx.skuCode] != null ? String(row[idx.skuCode]).trim() : null;
    const qty = row[idx.qty] != null ? Number(row[idx.qty]) : 0;
    const invDate = idx.invDate !== -1 ? parseInvDate(row[idx.invDate]) : null;
    if (!outlet || !skuCode) continue;
    parsed.push({ outlet, skuCode, qty: isNaN(qty) ? 0 : qty, invDate });
  }
  return { rows: parsed, headerMissing: false };
}
