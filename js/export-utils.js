// Helper export ke Excel (format mentah/long -- 1 baris per kombinasi, siap di-pivot).
// Pakai library XLSX yang sudah dimuat via CDN <script> di halaman (window.XLSX).

export function downloadAsExcel(rows, filename, sheetName) {
  if (!window.XLSX) {
    throw new Error('Library XLSX belum termuat di halaman ini.');
  }
  if (!rows || !rows.length) {
    throw new Error('Tidak ada data untuk di-export.');
  }
  const ws = window.XLSX.utils.json_to_sheet(rows);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Data').slice(0, 31));
  window.XLSX.writeFile(wb, filename);
}
