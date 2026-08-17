const SKU_FILES = {
  'lmt-spm': 'data/sku-lmt-spm.json',
  'local-minis': 'data/sku-local-minis.json',
  'haba-dt': 'data/sku-haba-dt.json'
};

let storesCache = null;
const skuCache = {};
let hargaProdukCache = null;

export async function loadStores() {
  if (storesCache) return storesCache;
  const res = await fetch('data/stores.json');
  storesCache = await res.json();
  return storesCache;
}

export async function loadSkuList(scopeSlug) {
  if (skuCache[scopeSlug]) return skuCache[scopeSlug];
  const path = SKU_FILES[scopeSlug];
  if (!path) throw new Error('Scope channel tidak dikenal: ' + scopeSlug);
  const res = await fetch(path);
  skuCache[scopeSlug] = await res.json();
  return skuCache[scopeSlug];
}

// Daftar produk untuk survei harga: gabungan SKU wajib LMT SPM (dengan flag) + SKU
// dari file promo Consumer Promo (tanpa flag, punya RSP). Lihat scripts/build_data.py
// bagian build_harga_produk untuk cara regenerate.
export async function loadHargaProduk() {
  if (hargaProdukCache) return hargaProdukCache;
  const res = await fetch('data/harga-produk.json');
  hargaProdukCache = await res.json();
  return hargaProdukCache;
}

export function groupStoresByArea(stores) {
  const byArea = {};
  for (const s of stores) {
    if (!byArea[s.area]) byArea[s.area] = [];
    byArea[s.area].push(s);
  }
  return byArea;
}
