// Pilihan sumber data. DEFAULT = perilaku lama (data master dari file JSON di repo, transaksi di Firebase),
// jadi menambahkan file ini TIDAK mengubah apa pun sampai Anda mengganti nilainya.
//
//   master       : 'static' = data/*.json di repo (default)
//                  'sheets' = Google Sheets (tab Toko, SKU_Wajib, Kode_SKU, Mapping_Akun) lewat Apps Script.
//                             Kalau Sheets tidak bisa dijangkau, otomatis pakai salinan terakhir di HP,
//                             lalu file JSON di repo (aplikasi tidak pernah "kosong").
//   transactions : 'firebase' = Firestore (default)
//                  'sheets'   = Google Sheets (tab _entries, _priceEntries, ...). Stock distributor tetap
//                               snapshot terakhir saja (setiap unggahan MENIMPA), tanpa histori.
//   endpoint     : URL Web App Apps Script (berakhiran /exec)
//   token        : sama dengan Script property API_TOKEN di Apps Script
//
// Panduan lengkap: sheets-backend/README.md
export const BACKEND = {
  master: 'static',
  transactions: 'firebase',
  endpoint: '',
  token: '',
  masterTimeoutMs: 8000,
  masterFreshMs: 90000   // salinan master di HP dipakai langsung bila umurnya kurang dari ini
};
