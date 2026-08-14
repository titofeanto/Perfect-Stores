const SKU_FILES = {
  'lmt-spm': 'data/sku-lmt-spm.json',
  'local-minis': 'data/sku-local-minis.json',
  'haba-dt': 'data/sku-haba-dt.json'
};

let storesCache = null;
const skuCache = {};

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

export function groupStoresByArea(stores) {
  const byArea = {};
  for (const s of stores) {
    if (!byArea[s.area]) byArea[s.area] = [];
    byArea[s.area].push(s);
  }
  return byArea;
}
