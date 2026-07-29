# SBA COTC - Input SKU Wajib

App sederhana untuk SBA (Sahabat Belanja Anda) mengisi data SKU wajib (COTC:
Stock, Order, Barang Masuk Toko, Penjualan) per toko, per minggu kalender
(Senin - Minggu), dengan rekap otomatis dan data tersambung ke database
terpusat (Firebase Firestore) supaya semua toko dan area bisa terkumpul di
satu tempat.

Status: prototipe fungsional. Sebelum dipakai operasional sungguhan, baca
bagian **Keterbatasan & yang masih perlu diputuskan** di bawah.

## Fitur

- Pilih Area (Sorong / Timika) lalu Toko - daftar toko dan scope channel-nya
  diambil dari `COTC_BY_GROUP.xlsx`.
- SKU wajib otomatis menyesuaikan scope channel toko (LMT SPM / Local Minis /
  Haba DT), masing-masing dengan tanda **COTC**, **Market making**, atau
  **NPD**.
- Pilih bulan dan minggu kalender (Senin - Minggu); tanggal rentang minggu
  ditampilkan otomatis.
- Pengingat (banner) kalau minggu berjalan/sudah lewat deadline dan masih ada
  SKU belum lengkap.
- Kolom yang dikosongkan diberi peringatan akan otomatis tercatat 0 saat
  dikirim (bukan diam-diam dianggap lengkap).
- Rekap: total SKU wajib, lengkap, belum lengkap, dan yang stock-nya 0
  ("tidak ada di toko").
- Upload laporan stock distributor (format template `UID Distributor Stock
  Report`) per area (Sorong / Timika), dicocokkan ke SKU lewat PC Code, lalu
  ditampilkan sebagai info tambahan di daftar SKU.
- Data tersimpan di Firebase Firestore (bukan cuma di HP masing-masing SBA),
  jadi bisa direkap lintas toko/area dari satu database.

## Struktur project

```
index.html
css/style.css
js/
  weeks.js          - perhitungan minggu kalender Senin-Minggu
  firebase-init.js   - inisialisasi Firebase + anonymous sign-in
  store-data.js       - load data toko & SKU wajib (dari /data)
  stock-upload.js     - parsing file stock distributor + simpan ke Firestore
  app.js              - logic utama UI
data/
  stores.json           - 36 toko (Sorong 7, Timika 29)
  sku-lmt-spm.json       - SKU wajib untuk scope channel LMT SPM
  sku-local-minis.json   - SKU wajib untuk scope channel Local Minis
  sku-haba-dt.json       - SKU wajib untuk scope channel Haba DT
scripts/build_data.py    - script untuk regenerate file di /data dari Excel sumber
firebase-config.js       - config project Firebase Anda (isi sendiri, lihat di bawah)
firestore.rules          - baseline security rules Firestore
```

## Setup (wajib sebelum app bisa dipakai)

App ini butuh **satu project Firebase** sebagai database terpusat. Firebase
punya paket gratis (Spark plan) yang cukup untuk skala 36 toko.

### 1. Buat project Firebase

1. Buka https://console.firebase.google.com, klik **Add project**, ikuti
   langkahnya (nama bebas, Google Analytics boleh dimatikan).
2. Di dalam project, klik ikon web (`</>`) untuk **Add app** - pilih Web app,
   kasih nama, klik **Register app**. Anda akan diberi objek `firebaseConfig`
   (apiKey, authDomain, projectId, dst).
3. Salin nilai-nilainya ke file `firebase-config.js` di root project ini,
   menggantikan nilai `GANTI_...`. Config ini aman untuk disimpan di repo
   publik - keamanan diatur lewat Firestore Rules, bukan dengan
   menyembunyikan config ini.

### 2. Aktifkan Firestore Database

1. Di sidebar Firebase Console: **Build > Firestore Database > Create
   database**.
2. Pilih lokasi server (misalnya `asia-southeast2` / Jakarta kalau tersedia).
3. Pilih mode **production** (bukan test mode).
4. Setelah dibuat, buka tab **Rules**, hapus isinya, lalu tempel isi file
   `firestore.rules` dari project ini, klik **Publish**.

### 3. Aktifkan Anonymous Authentication

App ini pakai sign-in anonymous supaya Firestore Rules bisa membedakan
"pengguna app ini" vs orang asing di internet, tanpa perlu bikin akun/login
manual untuk tiap SBA.

1. Sidebar: **Build > Authentication > Get started**.
2. Tab **Sign-in method** > aktifkan **Anonymous**.

### 4. Jalankan lokal untuk tes

Karena app ini pakai ES modules dan `fetch()` untuk load file JSON, harus
dibuka lewat server lokal (tidak bisa langsung buka `index.html` dari
file explorer). Contoh:

```
npx serve .
# atau
python3 -m http.server 8080
```

Lalu buka `http://localhost:8080` (atau port yang muncul) di browser.

### 5. Publish ke GitHub Pages

```
git init
git add .
git commit -m "Initial commit: SBA COTC app"
git branch -M main
git remote add origin <URL_REPO_GITHUB_ANDA>
git push -u origin main
```

Lalu di GitHub: **Settings > Pages** - Source: `Deploy from a branch`,
Branch: `main`, folder `/ (root)` - Save. Setelah beberapa menit, app bisa
diakses di `https://<username>.github.io/<nama-repo>/`.

## Cara update data toko / SKU wajib

Kalau daftar toko atau SKU wajib berubah (ada toko baru, SKU wajib ganti,
dst), source of truth-nya adalah file Excel (`COTC_BY_GROUP.xlsx` dan
`PH_SKU_AUDIT.xlsx`), bukan file JSON di `/data` secara langsung. Update
Excel-nya, taruh di folder yang sama dengan `scripts/build_data.py`, lalu
jalankan:

```
pip install openpyxl --break-system-packages
python3 scripts/build_data.py
```

Ini akan menimpa ulang semua file di `/data`.

## Model data di Firestore

- Koleksi `entries`, satu dokumen per toko per minggu, id:
  `{storeId}__{tanggal-senin-minggu-itu}` (misal
  `910717000401263480__2026-07-27`). Isinya field `items` berupa map per
  barcode dengan `stock/order/masuk/jual`, plus `submitted` dan
  `submittedAt` setelah SBA klik "Konfirmasi dan kirim".
- Koleksi `distributorStock`, satu dokumen per area (`Sorong` / `Timika`),
  berisi hasil parsing file upload terakhir.

## Keterbatasan & yang masih perlu diputuskan

Saya tulis eksplisit di sini karena beberapa hal ini adalah asumsi saya yang
belum tentu sesuai kebutuhan operasional Anda sebenarnya:

1. **Rules Firestore saat ini baseline saja** - membedakan "pengguna app
   ini" vs orang asing di internet, TAPI tidak membedakan SBA satu dengan
   SBA lain (siapa pun yang buka link app-nya bisa baca/tulis data toko
   mana pun). Kalau perlu tiap SBA hanya bisa isi data tokonya sendiri, atau
   perlu log siapa yang mengisi, ini perlu ditingkatkan (misal pakai login
   email/password per SBA atau custom claim per area) - source datanya sudah
   siap untuk itu, tapi belum saya bangun.
2. **Definisi SKU Wajib per flag** - sesuai instruksi Anda, semua baris
   (COTC, Market making, NPD) ditampilkan dengan tandanya masing-masing, dan
   semuanya dihitung sebagai "SKU wajib" di progress/rekap. Kalau ternyata
   Market making dan NPD seharusnya tidak ikut dihitung di progress
   kelengkapan (hanya ditampilkan sebagai info), rekapnya perlu saya pisah.
3. **Pencocokan barcode -> PC Code** untuk join ke stock distributor: 199
   dari 201 (LMT SPM), 116/116 (Local Minis), 99/99 (Haba DT) berhasil
   dicocokkan lewat `PH_SKU_AUDIT.xlsx`. Sisanya (2 SKU di LMT SPM) tidak
   ketemu pasangannya, jadi tidak akan muncul info stock distributor untuk 2
   SKU itu - saya belum investigasi manual kenapa.
4. **Definisi minggu kalender**: Senin-Minggu murni, sehingga minggu
   pertama/terakhir tiap bulan bisa memuat beberapa hari dari bulan
   sebelum/sesudahnya. Kalau ada aturan khusus perusahaan untuk minggu yang
   terpotong ini, beri tahu saya.
5. Belum ada halaman rekap **lintas toko** (misal: dashboard melihat semua
   36 toko sekaligus per minggu) - saat ini rekap hanya per toko yang sedang
   dipilih. Ini bisa dibangun kalau dibutuhkan, dengan query ke koleksi
   `entries` berdasarkan `periodKey`.
6. Belum ada testing di HP/browser sungguhan (saya cek logika perhitungan
   minggu dan sintaks kode saja) - sebaiknya dites langsung setelah
   Firebase disetel, sebelum dipakai tim SBA di lapangan.
