// Stock distributor (DT) per BARCODE. Laporan distributor dicatat per SKU Code, dan
// 1 barcode bisa punya beberapa SKU Code (sku.codes, dari scripts/build_sku_codes.py),
// jadi stock DT sebuah barcode = jumlah semua SKU Code-nya. Dipakai app.js (hint di
// halaman input SBA) dan dashboard.js (drill-down "Tidak ada"), supaya hitungannya sama.
//
// distStockItems: map {skuCode: {karton, lusin, pcs, isi}} dari distributorStock/{area}.

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function hasDistributorData(distStockItems) {
  return !!distStockItems && Object.keys(distStockItems).length > 0;
}

export function computeDtStock(sku, distStockItems) {
  const hasDtData = hasDistributorData(distStockItems);
  distStockItems = distStockItems || {};
  const skuCodes = sku.codes && sku.codes.length
    ? sku.codes
    : (sku.pcode ? [{ code: sku.pcode, name: sku.name, isi: sku.isi, status: '' }] : []);
  const codes = [];
  let hiddenDelisted = 0;
  for (const c of skuCodes) {
    const dt = distStockItems[c.code];
    const isi = Number(dt && dt.isi) || c.isi || sku.isi || 0;
    const breakdown = dt
      ? { karton: Number(dt.karton) || 0, lusin: Number(dt.lusin) || 0, pcs: Number(dt.pcs) || 0 }
      : null;
    const qtyPcs = breakdown ? breakdown.karton * isi + breakdown.lusin * 12 + breakdown.pcs : 0;
    // Kode delisted tanpa stock tidak berguna buat order -- disembunyikan supaya daftar tidak panjang.
    if (c.status === 'Delisted' && qtyPcs <= 0) { hiddenDelisted++; continue; }
    codes.push({ code: c.code, name: c.name, status: c.status, isi, breakdown, qtyPcs });
  }
  // Yang ada stock paling atas, lalu yang terdaftar tapi 0, lalu yang tidak ada di laporan DT.
  codes.sort((a, b) => (b.qtyPcs > 0) - (a.qtyPcs > 0) || (!!b.breakdown - !!a.breakdown));
  const dtQty = codes.reduce((sum, c) => sum + c.qtyPcs, 0);
  return { hasDtData, dtQty, codes, hiddenDelisted };
}

// Total pcs -> "X karton, Y lusin, Z pcs" (karton pakai isi per karton barcode itu; kalau tidak
// diketahui, langsung lusin/pcs).
export function fmtTotal(totalPcs, isi) {
  let rest = totalPcs;
  const karton = isi ? Math.floor(rest / isi) : 0;
  rest -= karton * (isi || 0);
  const lusin = Math.floor(rest / 12);
  const pcs = rest - lusin * 12;
  return `${karton} karton, ${lusin} lusin, ${pcs} pcs`;
}

function fmtBreakdown(b) {
  return b ? `${b.karton} karton, ${b.lusin} lusin, ${b.pcs} pcs` : 'tidak ada di laporan DT';
}

// Rincian per SKU Code, collapsible (klik untuk buka). Kosong kalau data DT belum ada.
export function dtCodesHtml(stock) {
  if (!stock.hasDtData || !stock.codes.length) return '';
  const withStock = stock.codes.filter(c => c.qtyPcs > 0).length;
  const rows = stock.codes.map(c => {
    const cls = c.qtyPcs > 0 ? 'has-stock' : 'no-stock';
    const statusNote = c.status && c.status !== 'Active' ? ` &middot; ${esc(c.status)}` : '';
    const isiNote = c.isi ? ` &middot; 1 karton = ${c.isi} pcs` : '';
    return `
      <div class="dt-code-row ${cls}">
        <p class="dt-code-head"><span class="dt-code-no">${esc(c.code)}</span>${statusNote}</p>
        <p class="dt-code-name">${esc(c.name)}${isiNote}</p>
        <p class="dt-code-qty">${fmtBreakdown(c.breakdown)}${c.qtyPcs > 0 ? ` (= ${c.qtyPcs} pcs)` : ''}</p>
      </div>`;
  }).join('');
  const hiddenNote = stock.hiddenDelisted
    ? `<p class="upload-status">${stock.hiddenDelisted} SKU Code delisted tanpa stock tidak ditampilkan.</p>` : '';
  return `
    <details class="dt-codes">
      <summary>${stock.codes.length} SKU Code &middot; ${withStock} ada stock di DT</summary>
      ${rows}${hiddenNote}
    </details>`;
}
