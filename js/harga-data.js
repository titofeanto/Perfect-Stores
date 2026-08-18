import { db, doc, getDoc, setDoc, serverTimestamp } from './firebase-init.js';

// Semua data kompetitor disimpan di SATU dokumen (bukan 1 dokumen per produk) supaya
// cukup 1x baca untuk semua 502 produk sekaligus, bukan ratusan read terpisah.
// Struktur: { items: { [pcode]: { [competitorId]: {brand, productName, packSize, addedAt} } } }
const COMPETITORS_DOC = 'all';

export async function loadCompetitors() {
  const ref = doc(db, 'competitors', COMPETITORS_DOC);
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data().items || {}) : {};
}

// Begitu ditambahkan oleh siapa pun, langsung tersimpan global -- toko/user lain yang
// buka survei harga produk yang sama akan langsung melihat kompetitor ini juga.
export async function addCompetitor(pcode, competitor) {
  const competitorId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ref = doc(db, 'competitors', COMPETITORS_DOC);
  await setDoc(ref, {
    items: {
      [pcode]: {
        [competitorId]: {
          brand: competitor.brand,
          productName: competitor.productName,
          packSize: competitor.packSize || null,
          addedAt: serverTimestamp()
        }
      }
    }
  }, { merge: true });
  return competitorId;
}

// Koreksi data kompetitor yang sudah ada (misal salah ketik nama brand) -- berlaku
// global juga, langsung berubah untuk semua toko begitu disimpan.
export async function updateCompetitor(pcode, competitorId, competitor) {
  const ref = doc(db, 'competitors', COMPETITORS_DOC);
  await setDoc(ref, {
    items: {
      [pcode]: {
        [competitorId]: {
          brand: competitor.brand,
          productName: competitor.productName,
          packSize: competitor.packSize || null,
          editedAt: serverTimestamp()
        }
      }
    }
  }, { merge: true });
}

function priceDocId(storeId, periodKey) {
  return `${storeId}__${periodKey}`;
}

export async function loadPriceEntry(storeId, periodKey) {
  const ref = doc(db, 'priceEntries', priceDocId(storeId, periodKey));
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data().items || {}) : {};
}

// Simpan 1 field harga (harga produk Unilever ATAU harga salah satu kompetitornya)
// untuk 1 produk, tanpa menimpa field harga produk/kompetitor lain di dokumen yang sama.
export async function savePriceField(storeMeta, periodKey, pcode, kind, competitorId, price) {
  const ref = doc(db, 'priceEntries', priceDocId(storeMeta.id, periodKey));
  const itemUpdate = kind === 'unilever'
    ? { unileverPrice: price }
    : { competitorPrices: { [competitorId]: price } };
  await setDoc(ref, {
    storeId: storeMeta.id,
    storeName: storeMeta.name,
    area: storeMeta.area,
    periodKey,
    items: { [pcode]: itemUpdate },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

// SKU Promo: berlaku per Channel (scopeSlug) per bulan (YYYY-MM), di-upload manual oleh
// tim (bukan file statis) supaya bisa berubah tiap bulan tanpa perlu ubah kode.
function promoDocId(scopeSlug, periodKey) {
  return `${scopeSlug}__${periodKey}`;
}

export async function loadPromoSku(scopeSlug, periodKey) {
  const ref = doc(db, 'promoSku', promoDocId(scopeSlug, periodKey));
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null; // {items:[...], sourceFileName, uploadedAt} atau null kalau belum ada
}

export async function savePromoSku(scopeSlug, periodKey, items, sourceFileName) {
  const ref = doc(db, 'promoSku', promoDocId(scopeSlug, periodKey));
  await setDoc(ref, {
    scopeSlug,
    periodKey,
    items,
    sourceFileName: sourceFileName || null,
    uploadedAt: serverTimestamp()
  });
}
