// Excel "list SKU push order" untuk dibagikan ke salesman supaya PO ke toko bisa segera diterbitkan.
// Urutan SKU sama dengan gambar WhatsApp (share-image.js): yang ada stock di DT dulu, stock DT terbanyak di atas.
// Pakai library XLSX yang sudah dimuat via CDN <script> di halaman (window.XLSX).
import { fmtTotal } from './dt-stock.js?v=1';
import { paginateShareItems } from './share-image.js?v=4';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function slug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40) || 'toko';
}

function dtStatusText(d) {
  if (!d.hasDtData) return 'Data stock DT belum di-upload';
  return d.dtQty > 0 ? 'Ada stock di DT - push order' : 'Kosong di DT - Request SPO / tanya kapan datang';
}

// store: {id, name, area}; week: {label}; weekRange: '14 Sep - 20 Sep'; oosDetail: hasil buildOosDetail()
export function buildPushOrderWorkbook({ store, week, weekRange, oosDetail }) {
  if (!window.XLSX) throw new Error('Library XLSX belum termuat di halaman ini.');
  const ordered = paginateShareItems(oosDetail).pages.flat();
  if (!ordered.length) throw new Error('Tidak ada SKU kosong untuk di-export.');

  const orderRows = ordered.map((d, i) => {
    const best = d.codes.find(c => c.qtyPcs > 0); // kode dengan stock DT terbanyak (codes sudah terurut)
    const hasStock = d.hasDtData && d.dtQty > 0;
    return {
      'No': i + 1,
      'Kode Outlet': store.id,
      'Toko': store.name,
      'Area': store.area,
      'Minggu': `${week.label} (${weekRange})`,
      'Barcode': String(d.barcode),
      'Nama Produk': d.name,
      'Status DT': dtStatusText(d),
      'SKU Code Disarankan': best ? best.code : '',
      'Stock DT (pcs)': hasStock ? d.dtQty : 0,
      'Stock DT (karton/lusin/pcs)': hasStock ? fmtTotal(d.dtQty, d.isi) : '',
      'Isi per Karton (pcs)': d.isi || '',
      'Qty Order (karton)': '',
      'Catatan': '',
    };
  });

  const codeRows = [];
  ordered.forEach(d => {
    d.codes.filter(c => c.qtyPcs > 0).forEach(c => {
      codeRows.push({
        'Barcode': String(d.barcode),
        'Nama Produk': d.name,
        'SKU Code': String(c.code),
        'Nama SKU Code': c.name,
        'Status SKU': c.status || '',
        'Stock DT (pcs)': c.qtyPcs,
        'Stock DT (karton/lusin/pcs)': fmtTotal(c.qtyPcs, c.isi),
        'Isi per Karton (pcs)': c.isi || '',
      });
    });
  });

  const X = window.XLSX;
  const wb = X.utils.book_new();
  const ws1 = X.utils.json_to_sheet(orderRows);
  ws1['!cols'] = [6, 20, 32, 12, 24, 16, 46, 40, 20, 14, 26, 16, 16, 24].map(wch => ({ wch }));
  X.utils.book_append_sheet(wb, ws1, 'Push Order');
  if (codeRows.length) {
    const ws2 = X.utils.json_to_sheet(codeRows);
    ws2['!cols'] = [16, 46, 12, 46, 18, 14, 26, 16].map(wch => ({ wch }));
    X.utils.book_append_sheet(wb, ws2, 'Rincian SKU Code');
  }
  const array = X.write(wb, { bookType: 'xlsx', type: 'array' });
  return {
    blob: new Blob([array], { type: XLSX_MIME }),
    filename: `push-order-${slug(store.name)}-${slug(week.label)}.xlsx`,
    total: orderRows.length,
    available: ordered.filter(d => d.hasDtData && d.dtQty > 0).length,
  };
}

// Di HP: menu bagikan bawaan dengan file Excel terlampir (pilih WhatsApp -> kontak salesman).
// Di komputer / browser tanpa dukungan: file diunduh, lalu WhatsApp dibuka dengan teks -- file tinggal di-drag ke chat.
// Mengembalikan 'shared' | 'downloaded' | 'cancelled'.
export async function shareExcel(blob, filename, caption) {
  const file = new File([blob], filename, { type: XLSX_MIME });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: caption });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      console.error('Share Excel gagal, pakai unduhan:', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  window.open('https://wa.me/?text=' + encodeURIComponent(caption), '_blank', 'noopener');
  return 'downloaded';
}
