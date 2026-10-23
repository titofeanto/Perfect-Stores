# Logika dan "otak" aplikasi Perfect Stores (SBA COTC)

Dokumen ini mencatat cara aplikasi berpikir: apa yang disimpan, bagaimana angka dihitung, dan aturan yang
dipakai. Dibuat 22 Oktober 2026. Perbarui bila logikanya berubah. Panduan pasang dan setup ada di `README.md`.

## 1. Tujuan

Tim lapangan (SBA, supervisor, field force) mengisi ketersediaan SKU wajib per toko per minggu. Aplikasi
merangkum hasilnya lintas toko, membandingkannya dengan stock distributor (DT), dan menunjukkan SKU mana
yang kosong di toko tetapi masih ada di DT, supaya order bisa dikejar.

## 2. Teknologi dan hosting

- Aplikasi statis (HTML + ES modules), tanpa build. Di-host di GitHub Pages repo `titofeanto/Perfect-Stores`.
- Database transaksi: **Firebase Firestore** dengan anonymous sign-in (`js/firebase-init.js` memilih backend).
- Data master (toko, SKU) berupa file JSON di repo (`data/`). Opsi Google Sheets + Apps Script ada di
  `backend-config.js` dan `sheets-backend/`, tetapi **tidak aktif** (`master: 'static'`, `transactions: 'firebase'`).
- Library luar lewat CDN: SheetJS (`xlsx`) untuk baca/tulis Excel.

## 3. Halaman

| Halaman | Isi | Skrip utama |
|---|---|---|
| `index.html` | Input SBA per toko dan minggu: tab Input, Rekap, Stock distributor, Masuk | `js/app.js` |
| `dashboard.html` | Rekap lintas toko: kelengkapan, OSA, peluang order, export | `js/dashboard.js` |
| `harga.html` | Survei harga bulanan (harga jual dan kompetitor) | `js/harga.js` |
| `mapping.html` | Buat `user-mapping.json` (penyaring toko per akun) | `js/mapping.js` |
| `versi.html` | Riwayat versi daftar toko dan SKU | skrip inline |
| `panduan.html` | Panduan dan FAQ | statis |

Navigasi bawah (`js/bottom-nav.js`) menampilkan Input, Survei Harga, Dashboard, Akun.

## 4. Konsep inti

**Minggu.** Senin sampai Minggu (`js/weeks.js`). Kunci periode (`periodKey`) = tanggal Senin, format `YYYY-MM-DD`.
Satu minggu yang melintasi dua bulan muncul di kedua bulan, tetapi datanya satu.

**Toko dan channel.** Tiap toko punya `id`, `name`, `area`, `scopeChannel` (LMT SPM / Local Minis / Haba DT)
dan `scopeSlug` (`lmt-spm`, `local-minis`, `haba-dt`).

**SKU wajib dan flag.** Setiap toko punya daftar SKU wajib dengan flag **COTC**, **MARKET MAKING** atau **NPD**.
Ketiganya dihitung sebagai SKU wajib. Flag bisa berbeda antar toko untuk barcode yang sama.

**Satuan.** Isian berupa karton, lusin, pcs. 1 lusin = 12 pcs. Karton dikonversi dengan `isi` (pcs per karton)
dari data SKU. Bila `isi` tidak diketahui, karton diabaikan (`fieldTotal` di `js/entry-utils.js`).

**Field yang diisi SBA.** Hanya `stock` dan `order`. `masuk` diisi lewat unggahan data pembelian toko oleh
supervisor. `jual` dihitung otomatis: stock minggu ini + masuk minggu ini - stock minggu depan.

## 5. Data di Firestore

Koleksi `entries`, satu dokumen per toko per minggu, id `{storeId}__{periodKey}`:

- `storeId`, `storeName`, `area`, `scopeSlug`, `periodKey`, `weekStart`, `weekEnd`
- `items`: map per barcode, tiap item berisi `stock`, `order`, `masuk`, `jual` sebagai `{karton, lusin, pcs, total}`
- `promoItems`: stock SKU promo (opsional) per PC Code
- `submitted`, `submittedAt`: diisi saat SBA klik "Konfirmasi dan kirim". Kolom kosong dicatat 0 saat kirim
- `listVersion`: id versi daftar toko/SKU yang dipakai entry ini (lihat bagian 7)
- `dtSnapshot`: stock distributor saat rekap dikirim (lihat bagian 8)

Koleksi lain: `distributorStock/{area}` (hasil unggahan laporan distributor terakhir, tertimpa tiap unggahan),
`priceEntries`, `competitors`, `promoSku`.

Rules Firestore (`firestore.rules`) hanya mensyaratkan sudah sign-in anonymous. Tidak membedakan SBA satu
dengan lainnya. Filter akun (`user-mapping.json`) hanya merapikan tampilan, bukan pembatas akses.

## 6. Cara angka dihitung

Dihitung per toko terhadap daftar SKU wajibnya (`summarizeEntry` di `js/entry-utils.js`):

- **Lengkap**: SKU dengan `stock` dan `order` keduanya terisi.
- **Ada**: `stock` terisi dan > 0. **Tidak ada**: `stock` terisi dan = 0. **Belum diisi**: `stock` kosong.
- **OSA (On Shelf Availability)** = SKU Ada dibagi total SKU wajib. Dashboard menjumlahkan lintas toko.
- **Kelengkapan %** = SKU Lengkap dibagi total SKU wajib.
- Ketersediaan per flag dihitung terpisah untuk COTC, Market making dan NPD.
- Status toko: `submitted` bila sudah kirim, `progress` bila ada entry tapi belum kirim, `notstarted` bila tidak ada entry.

Filter dashboard (channel, area, flag, bisnis unit, toko) menyaring **SKU** dan **toko** sebelum angka dihitung,
jadi semua persentase ikut berubah sesuai filter.

## 7. Versi daftar toko dan SKU

Daftar toko dan SKU berubah dari waktu ke waktu (file "SKU AUDIT"). Supaya data yang sudah terisi tidak ikut
berubah, tiap perubahan disimpan sebagai versi baru.

- `data/versions.json`: daftar versi (`id`, `label`, `effectiveFrom`, `updatedAt`, `summary`, `changes`).
- `data/ver/<id>.json`: `stores`, `skus` (per channel, dengan meta produk), `sets` + `storeSet` (barcode dan flag tiap toko;
  toko dengan daftar sama berbagi satu set).
- Dibuat oleh `scripts/build_versions.py`. `v1` = data awal, `v2` = SKU Audit Semeru Oktober 2026 (berlaku 1 Okt 2026).

Aturan memilih versi untuk satu toko pada satu minggu (`resolveListVersion` di `js/store-data.js`):

1. Entry sudah punya `listVersion`: pakai versi itu.
2. Entry berisi data tetapi belum punya `listVersion` (diisi sebelum sistem versi): pakai versi paling awal.
3. Entry kosong atau belum ada: pakai versi terbaru dengan `effectiveFrom <= periodKey`.

`listVersion` dicatat setiap kali SBA menyimpan isian, mengirim rekap, menyimpan SKU promo, atau saat data
`masuk` diunggah. Dashboard menampilkan toko dari versi minggu itu, ditambah toko yang sudah punya entry
(supaya toko yang sudah dikeluarkan tetap terlihat di minggu lamanya). Export memuat kolom `VersiDaftarSKU`.

Cara menambah versi baru: jalankan `scripts/build_versions.py` (contoh perintah ada di docstring skrip dan di
`versi.html`), lalu upload folder `data/`. File `data/stores.json` dan `data/sku-*.json` tetap ada sebagai
data awal dan cadangan.

## 8. Stock distributor (DT)

- Admin atau supervisor mengunggah laporan "UID Distributor Stock Report" per area (`js/stock-upload.js`).
  Kolom dibaca berdasarkan nama header. Tanggal laporan dan nama distributor dibaca dari sheet parameter.
- Stock dicatat per SKU Code. Satu barcode bisa punya beberapa SKU Code (`codes` di data SKU), jadi stock DT
  sebuah barcode = jumlah semua SKU Code-nya (`computeDtStock` di `js/dt-stock.js`). Kode Delisted tanpa stock disembunyikan.
- Setiap unggahan **menimpa** dokumen area itu. Hanya snapshot terakhir yang tersimpan.
- Karena itu, saat SBA mengirim rekap, aplikasi menyalin stock DT saat itu ke `entries.dtSnapshot`
  (pcs per barcode, `reportDate`, `distributorName`). Export memakai snapshot ini lewat kolom
  `StockDT_saat_kirim_pcs`, `StockDT_saat_kirim`, `TanggalLaporanDT` dan `WaktuKirim`.
  Rekap yang dikirim sebelum fitur ini diberi keterangan "Tidak tercatat".
- Angka DT di layar dashboard dan popup adalah kondisi **terkini**, bukan kondisi saat rekap dikirim.

- Tujuan unggah dipilih lebih dulu: Area, lalu Distributor (tanpa nilai awal, tidak diingat). Distributor tiap toko ada di
  data toko (`distributor` = "kode-nama", dari kolom Distributor Code&Name di file SKU Audit; di mode Sheets dari kolom
  `Distributor` tab Toko). Area dengan satu distributor langsung terpilih; area dengan dua distributor (mis. Jayapura,
  Timika, Manokwari) memaksa pilihan.
- Stock disimpan per distributor: `distributorStock/{area}__{kodeDistributor}`. Toko tanpa data distributor memakai dokumen lama
  `distributorStock/{area}`. Dokumen lama per area hanya dipakai toko berdistributor kalau nama distributor di dokumen itu cocok.
- Nama distributor di file (sheet "Selected Parameters", format `kode~nama`) dicocokkan dengan tujuan. Kalau beda, simpan
  diblokir sampai tujuan dipindahkan (tombol saran) atau SBA mencentang "Saya yakin". Simpan selalu lewat konfirmasi tujuan.

## 9. Peluang order

Di dashboard, setelah tabel "Semua toko" (`renderOpportunities` di `js/dashboard.js`):

1. Kumpulkan SKU yang `stock`-nya 0 di toko yang lolos filter (`buildOosDetail`).
2. Untuk tiap SKU, cocokkan dengan stock DT area tokonya. SKU "bisa dikejar" bila ada stock DT di minimal satu area.
3. Urutkan: paling banyak toko yang bisa dikejar, lalu paling banyak toko kosong, lalu nama.
4. Tampilkan 5 SKU teratas. Sisanya lewat tombol "Tampilkan semua". Klik satu SKU membuka rincian per area dan toko.
5. SKU yang kosong di toko dan juga kosong di DT dihitung terpisah: Request SPO atau tanya kapan datang.

Popup "SKU tidak ada di toko" per toko (`js/oos-modal.js`) bisa dibagikan sebagai gambar WhatsApp
(`js/share-image.js`, maksimal 15 SKU per gambar) atau Excel push order (`js/share-excel.js`).
Urutan: SKU yang ada stock DT dulu, stock DT terbanyak di atas.

## 10. Alur input SBA (`js/app.js`)

1. Pilih channel, area, toko, bulan dan minggu. Link dari dashboard bisa membawa `?store=...&period=...`.
2. `loadEntryForCurrentPeriod` membaca entry, menentukan versi daftar, lalu menyusun daftar SKU toko itu.
3. Isian disimpan otomatis per kolom (`setDoc` dengan merge) bersama `listVersion`.
4. "Konfirmasi dan kirim" mengisi kolom kosong dengan 0 (hanya stock dan order), menyimpan `dtSnapshot`,
   `submitted: true` dan `submittedAt`.
5. Tab Masuk: unggah data pembelian toko. Baris dicocokkan ke toko (kolom Outlet = storeId) dan SKU (SKU Code
   ke barcode), baris di luar minggu terpilih dibuang. Setelah tersimpan, `jual` dihitung ulang.

## 11. Survei harga (`js/harga.js`)

Bulanan, per toko. Produk = SKU wajib LMT SPM ditambah SKU promo. Mencatat harga jual dan harga kompetitor.
Unggahan Excel untuk harga, promo dan pembelian memakai template di `assets/`.

## 12. Export

- Dashboard: export satu toko (semua minggu yang pernah diisi) dan export semua toko (bulan terpilih).
  Format mentah satu baris per toko-minggu-SKU, siap di-pivot.
- Kolom: identitas toko, periode, flag, barcode, PC Code, nama produk, `Stock_pcs`, `Order_pcs`, `Masuk_pcs`,
  `Jual_pcs`, `SudahKirim`, `VersiDaftarSKU`, `WaktuKirim`, kolom stock DT saat kirim.

## 13. Cara memperbarui data

| Perubahan | Langkah |
|---|---|
| Daftar toko atau SKU baru | `scripts/build_versions.py` dengan file SKU Audit baru, upload `data/` |
| Daftar SKU Code per barcode | `scripts/build_sku_codes.py` dengan file Product Hierarchy (untuk data awal v1) |
| Stock distributor | Unggah laporan lewat tab Stock distributor |
| Filter tampilan per akun | `mapping.html`, lalu upload `data/user-mapping.json` |
| Kode aplikasi | Edit file, naikkan nomor `?v=` di tag script HTML supaya cache HP tidak memakai versi lama |

## 14. Keterbatasan yang diketahui

- Keamanan hanya sign-in anonymous. Siapa pun dengan link bisa membaca dan menulis data toko mana pun.
- Stock DT hanya snapshot terakhir. Histori tercatat hanya sejak fitur `dtSnapshot` aktif.
- Versi daftar belum berlaku untuk mode Google Sheets (satu versi sintetis dari master Sheet).
- Daftar toko di halaman Input memakai versi yang berlaku hari ini, jadi toko yang sudah dikeluarkan tidak muncul untuk input baru.
- Area toko tidak ada di file SKU Audit. Diambil dari data lama atau diduga lewat distributor, perlu dicek untuk toko baru.
- Belum ada pengujian otomatis. Logika pemilihan versi diuji dengan skrip sekali jalan, bukan test suite.

## Upload Extract: periode dan distributor

- Distributor TIDAK dipilih: toko dikenali dari kode Outlet di file. Kolom `DistID`/`DistName` (kalau ada) hanya dipakai untuk
  memeriksa: toko yang tercatat di distributor lain pada daftar toko diberi catatan, datanya tetap dihitung.
- Periode extract dipilih sendiri di tab ini, terpisah dari Minggu di bagian atas halaman. Bawaannya MINGGU LALU, karena setiap
  Senin supervisor mengunggah data 7 hari sebelumnya. Pengingat selalu tampil (lebih menonjol di hari Senin).
- Setelah file dibaca, tanggal `INVDate` dikelompokkan per minggu Senin-Minggu. Kalau minggu dominan di file berbeda dari periode
  yang dipilih, Simpan dikunci sampai periode diganti lewat tombol "Pakai periode ..." atau SBA mencentang "Saya yakin".
