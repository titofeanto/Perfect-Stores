import { db, collection, query, where, getDocs, authReady } from './firebase-init.js';
import { loadStores, loadSkuList } from './store-data.js';
import { MONTHS_ID } from './weeks.js';
import { loadCompetitors, addCompetitor, updateCompetitor, loadPriceEntry, savePriceField, saveBulkPriceEntries, loadPromoSku, savePromoSku } from './harga-data.js';
import { supportsNativeBarcodeDetector, startNativeScan, stopNativeScan, startFallbackScan, stopFallbackScan } from './barcode-scan.js';
import { parsePromoWorkbook } from './promo-upload.js';
import { parsePriceWorkbook } from './price-upload.js';
import { downloadAsExcel } from './export-utils.js';

const TODAY = new Date();
const el = (id) => document.getElementById(id);

const FLAG_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD' };
const FLAG_CLASS = { 'COTC': 'flag-cotc', 'MARKET MAKING': 'flag-market', 'NPD': 'flag-npd' };

const CHANNEL_LABELS = { 'lmt-spm': 'LMT SPM', 'local-minis': 'LMT Local Minis', 'haba-dt': 'HABA' };

let ecBigStores = [];
let allProducts = [];
let competitors = {}; // pcode -> {competitorId: {...}}
let currentEntry = {}; // pcode -> {unileverPrice, competitorPrices:{id:price}}
let currentStore = null;
let currentPeriodKey = null;
let searchText = '';
let flagFilter = 'all';
let saveTimers = {};
let openAddForm = null; // pcode yang sedang buka form tambah kompetitor
let editingCompetitor = null; // {pcode, competitorId} yang sedang diedit
let pendingPromoParse = null;
let pendingPriceParse = null;

function rp(n) {
  if (n === null || n === undefined || n === '') return '-';
  const num = Number(n);
  if (isNaN(num)) return '-';
  return 'Rp' + num.toLocaleString('id-ID');
}

// Kunci penyimpanan harga: pakai BARCODE (bukan PC Code) -- data harga dari toko
// biasanya per barcode/varian, sedangkan 1 PC Code kadang menaungi beberapa barcode
// sekaligus, jadi kalau dipakai kunci harga bisa salah gabung 2 varian jadi 1 harga.
// Fallback ke PC Code (dengan prefix) cuma untuk kasus langka produk tanpa barcode.
function priceKey(p) {
  return p.barcode || ('PC-' + p.pcode);
}

async function init() {
  await authReady;
  const allStores = await loadStores();
  // Survei harga: 8 toko LMT SPM "EC BIG" + 2 toko Beauty/Cosmetic Expert Traditional
  // (SAGA BEAUTY, DEDE MAMA) -- keduanya scope HABA DT.
  ecBigStores = allStores.filter(s =>
    s.subChannel === 'LOCAL SUPERMARKET EC BIG' || s.subChannel === 'COSMETIC EXPERT TRADITIONAL'
  );
  competitors = await loadCompetitors();

  populateStoreSelect();
  populateMonthSelect();
  populateChannelSelect();
  renderFlagFilterChips();

  el('storeSel').addEventListener('change', onStoreOrMonthChange);
  el('monthSel').addEventListener('change', onStoreOrMonthChange);
  el('searchBox').addEventListener('input', (e) => { searchText = e.target.value; renderProductList(); });
  el('scanBtn').addEventListener('click', openScanModal);
  el('scanCloseBtn').addEventListener('click', closeScanModal);
  el('promoFileInput').addEventListener('change', onPromoFileSelected);
  el('promoSaveBtn').addEventListener('click', onPromoSave);
  el('promoChannelSel').addEventListener('change', refreshPromoUploadInfo);
  el('priceFileInput').addEventListener('change', onPriceFileSelected);
  el('priceSaveBtn').addEventListener('click', onPriceUploadSave);
  el('exportStoreBtn').addEventListener('click', exportOneStorePrice);
  el('exportAllPriceBtn').addEventListener('click', exportAllStoresPrice);

  await onStoreOrMonthChange();
}

function populateChannelSelect() {
  el('promoChannelSel').innerHTML = Object.entries(CHANNEL_LABELS)
    .map(([slug, label]) => `<option value="${slug}">${label}</option>`).join('');
}

function populateStoreSelect() {
  el('storeSel').innerHTML = ecBigStores.map(s => `<option value="${s.id}">${s.name} (${s.area})</option>`).join('');
}

function populateMonthSelect() {
  const y = TODAY.getFullYear();
  const m = TODAY.getMonth();
  const options = [-1, 0, 1].map(delta => {
    let mm = m + delta, yy = y;
    if (mm < 0) { mm += 12; yy -= 1; }
    if (mm > 11) { mm -= 12; yy += 1; }
    return { y: yy, m: mm };
  });
  el('monthSel').innerHTML = options
    .map(o => `<option value="${o.y}-${String(o.m + 1).padStart(2, '0')}">${MONTHS_ID[o.m]} ${o.y}</option>`)
    .join('');
  el('monthSel').value = `${y}-${String(m + 1).padStart(2, '0')}`;
}

// Gabungkan SKU wajib scope toko itu (flag dipertahankan) dengan SKU Promo channel yang
// sama untuk bulan yang dipilih (flag=null, ditandai "Promo"). SKU wajib SELALU jadi acuan
// utama -- kalau ada tumpang tindih pcode, data SKU wajib yang menang, cuma RSP-nya
// dilengkapi dari data promo kalau ada.
function mergeProducts(wajibList, promoDoc) {
  const merged = {};
  for (const it of wajibList) {
    if (!it.pcode) continue;
    merged[it.pcode] = { pcode: it.pcode, barcode: it.barcode, name: it.name, flag: it.flag, isi: it.isi, rsp: null };
  }
  if (promoDoc && Array.isArray(promoDoc.items)) {
    for (const it of promoDoc.items) {
      if (merged[it.pcode]) {
        merged[it.pcode].rsp = it.rsp;
      } else {
        merged[it.pcode] = { pcode: it.pcode, barcode: it.barcode, name: it.name, flag: null, isi: null, rsp: it.rsp };
      }
    }
  }
  return Object.values(merged).sort((a, b) => a.name.localeCompare(b.name));
}

async function onStoreOrMonthChange() {
  currentStore = ecBigStores.find(s => s.id === el('storeSel').value);
  currentPeriodKey = el('monthSel').value; // format YYYY-MM
  if (!currentStore) return;

  const [wajibList, promoDoc, entry] = await Promise.all([
    loadSkuList(currentStore.scopeSlug),
    loadPromoSku(currentStore.scopeSlug, currentPeriodKey),
    loadPriceEntry(currentStore.id, currentPeriodKey)
  ]);
  allProducts = mergeProducts(wajibList, promoDoc);
  currentEntry = entry;

  // Produk ad-hoc (di luar SKU wajib/promo, ditambahkan lewat upload harga manual)
  // dimunculkan lagi dari data yang sudah tersimpan, pakai productName yang disimpan
  // bareng harganya waktu itu -- supaya tidak hilang begitu ganti toko/minggu lalu balik lagi.
  const knownKeys = new Set(allProducts.map(p => priceKey(p)));
  for (const [key, val] of Object.entries(currentEntry)) {
    if (knownKeys.has(key)) continue;
    allProducts.push({
      pcode: key.startsWith('PC-') ? key.slice(3) : null,
      barcode: key.startsWith('PC-') ? null : key,
      name: val.productName || `Produk (${key})`,
      flag: null,
      isi: null,
      rsp: null
    });
    knownKeys.add(key);
  }
  allProducts.sort((a, b) => a.name.localeCompare(b.name));

  el('promoChannelSel').value = currentStore.scopeSlug;
  refreshPromoUploadInfo();
  el('priceUploadTargetLabel').textContent = `${currentStore.name}, ${MONTHS_ID[Number(currentPeriodKey.split('-')[1]) - 1]} ${currentPeriodKey.split('-')[0]}`;
  pendingPriceParse = null;
  el('priceFileInput').value = '';
  el('priceParsePreview').textContent = '';
  el('priceParseDetail').innerHTML = '';
  el('priceSaveBtn').disabled = true;
  renderProgress();
  renderProductList();
}

async function refreshPromoUploadInfo() {
  const scopeSlug = el('promoChannelSel').value;
  el('promoSaveBtn').disabled = true;
  el('promoParsePreview').textContent = '';
  pendingPromoParse = null;
  el('promoCurrentInfo').textContent = 'Memuat...';
  try {
    const promoDoc = await loadPromoSku(scopeSlug, currentPeriodKey);
    if (promoDoc) {
      const ts = promoDoc.uploadedAt && promoDoc.uploadedAt.toDate ? promoDoc.uploadedAt.toDate().toLocaleString('id-ID') : '-';
      el('promoCurrentInfo').textContent = `${CHANNEL_LABELS[scopeSlug]}: ${promoDoc.items.length} SKU promo untuk bulan ini. Terakhir upload: ${ts}.`;
    } else {
      el('promoCurrentInfo').textContent = `${CHANNEL_LABELS[scopeSlug]}: belum ada SKU Promo untuk bulan ini.`;
    }
  } catch (err) {
    console.error('Gagal memuat info SKU Promo:', err);
    el('promoCurrentInfo').textContent = 'Gagal memuat info SKU Promo.';
  }
}

function onPromoFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  el('promoParsePreview').textContent = 'Membaca file...';
  el('promoSaveBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const { items, headerMissing } = parsePromoWorkbook(ev.target.result);
      if (headerMissing || !items.length) {
        el('promoParsePreview').textContent = 'Format file tidak dikenali. Pastikan ada kolom SKU Code Mapping, SKU Description Current, RSP.';
        return;
      }
      pendingPromoParse = { items, fileName: file.name };
      el('promoParsePreview').textContent = `${items.length} SKU promo terbaca, siap disimpan untuk channel ${CHANNEL_LABELS[el('promoChannelSel').value]}, ${MONTHS_ID[Number(currentPeriodKey.split('-')[1]) - 1]} ${currentPeriodKey.split('-')[0]}.`;
      el('promoSaveBtn').disabled = false;
    } catch (err) {
      console.error(err);
      el('promoParsePreview').textContent = 'Gagal membaca file.';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function onPromoSave() {
  if (!pendingPromoParse) return;
  const scopeSlug = el('promoChannelSel').value;
  const btn = el('promoSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    await savePromoSku(scopeSlug, currentPeriodKey, pendingPromoParse.items, pendingPromoParse.fileName);
    showToast(`SKU Promo ${CHANNEL_LABELS[scopeSlug]} tersimpan (${pendingPromoParse.items.length} SKU).`, 'success');
    pendingPromoParse = null;
    el('promoFileInput').value = '';
    el('promoParsePreview').textContent = '';
    await refreshPromoUploadInfo();
    if (currentStore.scopeSlug === scopeSlug) {
      await onStoreOrMonthChange();
    }
  } catch (err) {
    console.error('Gagal menyimpan SKU Promo:', err);
    showToast(`Gagal menyimpan (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
  } finally {
    btn.textContent = 'Simpan SKU Promo';
    btn.disabled = false;
  }
}

function renderProgress() {
  const total = allProducts.length;
  const filled = allProducts.filter(p => {
    const e = currentEntry[priceKey(p)];
    return e && e.unileverPrice !== undefined && e.unileverPrice !== '' && e.unileverPrice !== null;
  }).length;
  const pct = total ? Math.round((filled / total) * 100) : 0;
  el('progLabel').textContent = `${filled}/${total} harga produk terisi`;
  el('progPct').textContent = pct + '%';
  el('progBar').style.width = pct + '%';
}

function renderFlagFilterChips() {
  const flags = ['all', 'COTC', 'MARKET MAKING', 'NPD', 'PROMO'];
  const labels = { all: 'Semua', PROMO: 'Promo (non-wajib)' };
  el('flagFilterRow').innerHTML = flags.map(f => {
    const label = labels[f] || FLAG_LABELS[f] || f;
    return `<span class="chip ${flagFilter === f ? 'active' : ''}" data-flag="${f}">${label}</span>`;
  }).join('');
  el('flagFilterRow').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      flagFilter = chip.dataset.flag;
      el('flagFilterRow').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.flag === flagFilter));
      renderProductList();
    });
  });
}

function productBadge(p) {
  if (p.flag) return `<span class="badge ${FLAG_CLASS[p.flag] || 'flag-cotc'}">${FLAG_LABELS[p.flag] || p.flag}</span>`;
  return `<span class="badge flag-none">Promo (non-wajib)</span>`;
}

const GROUP_ORDER = ['COTC', 'MARKET MAKING', 'NPD', 'TIDAK_WAJIB'];
const GROUP_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD', 'TIDAK_WAJIB': 'Tidak wajib (Promo / dari upload)' };
let expandedGroups = {}; // groupKey -> bool, default collapsed

function productCardHtml(p) {
  const key = priceKey(p);
  const entry = currentEntry[key] || {};
  const unileverPrice = entry.unileverPrice ?? '';
  const compList = competitors[key] || {};
  const compIds = Object.keys(compList);

  const compHtml = compIds.map(cid => {
    const c = compList[cid];
    const price = (entry.competitorPrices || {})[cid] ?? '';
    const isEditing = editingCompetitor && editingCompetitor.key === key && editingCompetitor.competitorId === cid;
    if (isEditing) {
      return `
        <div class="competitor-item">
          <div class="competitor-form" data-edit-form-for="${key}" data-edit-competitor-id="${cid}">
            <label class="field-label">Brand kompetitor</label>
            <input type="text" class="comp-brand" value="${c.brand || ''}">
            <label class="field-label">Nama produk</label>
            <input type="text" class="comp-name" value="${c.productName || ''}">
            <label class="field-label">Ukuran kemasan (opsional)</label>
            <input type="text" class="comp-size" value="${c.packSize || ''}">
            <div style="display:flex; gap:6px;">
              <button type="button" class="comp-edit-cancel" style="flex:1;">Batal</button>
              <button type="button" class="comp-edit-save primary" style="flex:1;">Simpan koreksi</button>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <div class="competitor-item">
        <div class="competitor-name-row">
          <p class="competitor-name">${c.brand} - ${c.productName}${c.packSize ? ' (' + c.packSize + ')' : ''}</p>
          <button type="button" class="competitor-edit-btn" data-edit-key="${key}" data-edit-cid="${cid}" title="Koreksi data kompetitor">Edit</button>
        </div>
        <div class="price-input-wrap">
          <span>Rp</span>
          <input type="number" min="0" data-key="${key}" data-kind="competitor" data-competitor-id="${cid}" value="${price}" placeholder="Harga di toko ini">
        </div>
      </div>
    `;
  }).join('');

  const formOpen = openAddForm === key;

  return `
    <div class="sku-item" data-key="${key}">
      <p class="sku-name">${p.name}</p>
      <p class="sku-code">${p.barcode || ''}${p.pcode ? ' &middot; PC ' + p.pcode : ''}</p>
      <div>${productBadge(p)}</div>
      ${p.rsp ? `<p class="rsp-note">RSP (saran harga jual): ${rp(p.rsp)}</p>` : ''}
      <div class="price-row">
        <div class="price-row-head"><label>Harga di toko ini (produk Unilever)</label></div>
        <div class="price-input-wrap">
          <span>Rp</span>
          <input type="number" min="0" data-key="${key}" data-kind="unilever" value="${unileverPrice}" placeholder="Harga jual di toko">
        </div>
      </div>
      <div class="competitor-section">
        ${compHtml}
        ${formOpen ? `
          <div class="competitor-form" data-form-for="${key}">
            <label class="field-label">Brand kompetitor</label>
            <input type="text" class="comp-brand" placeholder="Misal: Wardah, Formula, Daia">
            <label class="field-label">Nama produk</label>
            <input type="text" class="comp-name" placeholder="Nama produk kompetitor">
            <label class="field-label">Ukuran kemasan (opsional)</label>
            <input type="text" class="comp-size" placeholder="Misal: 190g">
            <div style="display:flex; gap:6px;">
              <button type="button" class="comp-cancel" style="flex:1;">Batal</button>
              <button type="button" class="comp-save primary" style="flex:1;">Simpan kompetitor</button>
            </div>
          </div>
        ` : `<button type="button" class="add-competitor-btn" data-open-for="${key}">+ Tambah kompetitor</button>`}
      </div>
    </div>
  `;
}

function groupKeyOf(p) {
  return p.flag && GROUP_LABELS[p.flag] ? p.flag : 'TIDAK_WAJIB';
}

function filledCountOf(list) {
  return list.filter(p => {
    const e = currentEntry[priceKey(p)];
    return e && e.unileverPrice !== undefined && e.unileverPrice !== '' && e.unileverPrice !== null;
  }).length;
}

function renderProductList() {
  const q = searchText.trim().toLowerCase();
  const filtered = allProducts.filter(p => {
    if (flagFilter === 'PROMO' && p.flag) return false;
    if (flagFilter !== 'all' && flagFilter !== 'PROMO' && p.flag !== flagFilter) return false;
    if (q && !p.name.toLowerCase().includes(q) && !(p.barcode || '').includes(q) && !(p.pcode || '').includes(q)) return false;
    return true;
  });

  if (flagFilter !== 'all') {
    // Sudah tersaring ke 1 kategori lewat chip -- tampil flat, tidak perlu dikelompokkan lagi.
    el('productList').innerHTML = filtered.map(productCardHtml).join('')
      || '<p class="upload-status">Tidak ada produk yang cocok.</p>';
    wireProductListEvents();
    return;
  }

  // Tampilan "Semua": dikelompokkan per kategori, collapsed by default (produk bisa
  // ratusan/ribuan setelah upload harga manual menambah produk ad-hoc di luar SKU wajib).
  const groups = {};
  for (const p of filtered) {
    const g = groupKeyOf(p);
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
  }

  el('productList').innerHTML = GROUP_ORDER.filter(g => groups[g] && groups[g].length).map(g => {
    const list = groups[g];
    const filledN = filledCountOf(list);
    const isOpen = !!expandedGroups[g];
    return `
      <div class="product-group">
        <button type="button" class="promo-toggle product-group-toggle" data-group="${g}">
          <span>${GROUP_LABELS[g]} (${filledN}/${list.length} harga terisi)</span>
          <span class="product-group-icon ${isOpen ? 'open' : ''}">&#9656;</span>
        </button>
        <div class="product-group-body" data-group-body="${g}" style="display:${isOpen ? 'block' : 'none'}; margin-top:8px;">
          ${isOpen ? list.map(productCardHtml).join('') : ''}
        </div>
      </div>
    `;
  }).join('') || '<p class="upload-status">Tidak ada produk yang cocok.</p>';

  el('productList').querySelectorAll('.product-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group;
      expandedGroups[g] = !expandedGroups[g];
      renderProductList();
    });
  });
  wireProductListEvents();
}

function wireProductListEvents() {
  el('productList').querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const key = inp.dataset.key;
      const kind = inp.dataset.kind;
      if (!currentEntry[key]) currentEntry[key] = {};
      if (kind === 'unilever') {
        currentEntry[key].unileverPrice = inp.value;
        scheduleSave(key, 'unilever', null, inp.value);
      } else {
        const cid = inp.dataset.competitorId;
        if (!currentEntry[key].competitorPrices) currentEntry[key].competitorPrices = {};
        currentEntry[key].competitorPrices[cid] = inp.value;
        scheduleSave(key, 'competitor', cid, inp.value);
      }
      renderProgress();
    });
  });

  el('productList').querySelectorAll('[data-open-for]').forEach(btn => {
    btn.addEventListener('click', () => { openAddForm = btn.dataset.openFor; renderProductList(); });
  });
  el('productList').querySelectorAll('.comp-cancel').forEach(btn => {
    btn.addEventListener('click', () => { openAddForm = null; renderProductList(); });
  });
  el('productList').querySelectorAll('.comp-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.competitor-form');
      const key = form.dataset.formFor;
      const brand = form.querySelector('.comp-brand').value.trim();
      const productName = form.querySelector('.comp-name').value.trim();
      const packSize = form.querySelector('.comp-size').value.trim();
      if (!brand || !productName) {
        showToast('Isi minimal brand dan nama produk kompetitor.', 'danger');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';
      try {
        const cid = await addCompetitor(key, { brand, productName, packSize });
        if (!competitors[key]) competitors[key] = {};
        competitors[key][cid] = { brand, productName, packSize };
        openAddForm = null;
        showToast(`Kompetitor "${brand}" ditambahkan -- langsung terlihat di semua toko lain.`, 'success');
        renderProductList();
      } catch (err) {
        console.error('Gagal menambah kompetitor:', err);
        showToast(`Gagal menyimpan kompetitor (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
        btn.disabled = false;
        btn.textContent = 'Simpan kompetitor';
      }
    });
  });

  el('productList').querySelectorAll('.competitor-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingCompetitor = { key: btn.dataset.editKey, competitorId: btn.dataset.editCid };
      renderProductList();
    });
  });
  el('productList').querySelectorAll('.comp-edit-cancel').forEach(btn => {
    btn.addEventListener('click', () => { editingCompetitor = null; renderProductList(); });
  });
  el('productList').querySelectorAll('.comp-edit-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.competitor-form');
      const key = form.dataset.editFormFor;
      const cid = form.dataset.editCompetitorId;
      const brand = form.querySelector('.comp-brand').value.trim();
      const productName = form.querySelector('.comp-name').value.trim();
      const packSize = form.querySelector('.comp-size').value.trim();
      if (!brand || !productName) {
        showToast('Isi minimal brand dan nama produk kompetitor.', 'danger');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';
      try {
        await updateCompetitor(key, cid, { brand, productName, packSize });
        competitors[key][cid] = { ...competitors[key][cid], brand, productName, packSize };
        editingCompetitor = null;
        showToast(`Data kompetitor "${brand}" dikoreksi -- langsung berubah di semua toko.`, 'success');
        renderProductList();
      } catch (err) {
        console.error('Gagal mengoreksi kompetitor:', err);
        showToast(`Gagal menyimpan koreksi (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
        btn.disabled = false;
        btn.textContent = 'Simpan koreksi';
      }
    });
  });
}

function scheduleSave(key, kind, competitorId, value) {
  const timerKey = `${key}__${kind}__${competitorId || ''}`;
  clearTimeout(saveTimers[timerKey]);
  saveTimers[timerKey] = setTimeout(async () => {
    try {
      await savePriceField(currentStore, currentPeriodKey, key, kind, competitorId, value);
    } catch (err) {
      console.error('Gagal menyimpan harga:', err);
      showToast(`Gagal menyimpan (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
    }
  }, 600);
}

let usingNativeScan = false;

async function openScanModal() {
  el('scanModal').classList.add('show');
  el('scanStatus').textContent = 'Meminta izin kamera...';
  el('scanVideo').style.display = 'none';
  el('scanFallbackContainer').innerHTML = '';

  usingNativeScan = supportsNativeBarcodeDetector();

  if (usingNativeScan) {
    el('scanVideo').style.display = 'block';
    await startNativeScan(el('scanVideo'), onBarcodeDetected, onScanError);
    el('scanStatus').textContent = 'Arahkan kamera ke barcode produk.';
  } else {
    el('scanStatus').textContent = 'Menyiapkan scanner (perangkat ini pakai mode kompatibilitas)...';
    await startFallbackScan('scanFallbackContainer', onBarcodeDetected, onScanError);
    el('scanStatus').textContent = 'Arahkan kamera ke barcode produk.';
  }
}

function closeScanModal() {
  el('scanModal').classList.remove('show');
  if (usingNativeScan) stopNativeScan(el('scanVideo'));
  else stopFallbackScan();
}

function onScanError(err) {
  console.error('Scan error:', err);
  el('scanStatus').textContent = 'Tidak bisa mengakses kamera. Pastikan izin kamera diaktifkan untuk situs ini.';
}

function onBarcodeDetected(rawValue) {
  closeScanModal();
  const barcode = String(rawValue).trim();
  const product = allProducts.find(p => p.barcode === barcode);
  if (!product) {
    showToast(`Barcode ${barcode} tidak ada di daftar produk survei harga.`, 'danger');
    return;
  }
  flagFilter = 'all';
  searchText = barcode;
  el('searchBox').value = barcode;
  renderFlagFilterChips();
  renderProductList();
  const card = document.querySelector(`.sku-item[data-key="${priceKey(product)}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash-highlight');
    setTimeout(() => card.classList.remove('flash-highlight'), 1600);
  }
  showToast(`Ditemukan: ${product.name}`, 'success');
}

function onPriceFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  el('priceParsePreview').textContent = 'Membaca file...';
  el('priceParseDetail').innerHTML = '';
  el('priceSaveBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const { rows, headerMissing } = parsePriceWorkbook(ev.target.result);
      if (headerMissing) {
        el('priceParsePreview').textContent = 'Format file tidak dikenali. Pastikan ada kolom Barcode dan Harga.';
        return;
      }
      const result = processPriceRows(rows);
      pendingPriceParse = result;
      el('priceParsePreview').textContent = `${rows.length} baris dibaca untuk ${currentStore.name}: ${result.unileverCount} harga Unilever, ${result.competitorCount} harga kompetitor siap disimpan.`;
      let detail = '';
      if (result.adHocCount > 0) detail += `<p class="upload-status">${result.adHocCount} produk belum ada di daftar SKU wajib/promo toko ini -- otomatis ditambahkan sebagai produk tidak wajib.</p>`;
      if (result.tokoFilteredOut > 0) detail += `<p class="upload-status">${result.tokoFilteredOut} baris diabaikan karena kolom Toko tidak cocok dengan toko yang sedang dipilih.</p>`;
      if (result.unmatchedCompetitor > 0) detail += `<p class="upload-status">${result.unmatchedCompetitor} baris kompetitor diabaikan, nama kompetitornya belum terdaftar untuk produk itu (tambah dulu lewat "+ Tambah kompetitor" di daftar produk).</p>`;
      if (result.invalidRow > 0) detail += `<p class="upload-status">${result.invalidRow} baris diabaikan, tidak ada Barcode maupun PCCode.</p>`;
      el('priceParseDetail').innerHTML = detail;
      el('priceSaveBtn').disabled = (result.unileverCount + result.competitorCount) === 0;
    } catch (err) {
      console.error(err);
      el('priceParsePreview').textContent = 'Gagal membaca file.';
    }
  };
  reader.readAsArrayBuffer(file);
}

// Cocokkan baris mentah ke produk toko ini (by Barcode). Kalau barcode-nya BELUM ada di
// daftar produk toko ini (di luar SKU wajib/promo), produk itu tetap DITERIMA -- otomatis
// ditambahkan sebagai produk "tidak wajib" (flag=null, sama seperti SKU Promo), supaya
// survei harga bisa mencakup produk apa saja yang memang dilaporkan tokonya, bukan cuma
// yang sudah resmi terdaftar. NamaProduk dari file disimpan bareng harganya supaya
// produk ad-hoc ini tetap "nempel" walau halaman di-reload nanti.
function processPriceRows(rows) {
  const lookup = Object.fromEntries(allProducts.map(p => [priceKey(p), p]));
  const newProducts = [];
  const itemsMap = {};
  let unileverCount = 0, competitorCount = 0, adHocCount = 0, unmatchedCompetitor = 0, tokoFilteredOut = 0, invalidRow = 0;

  for (const row of rows) {
    if (row.toko) {
      const matches = row.toko.toLowerCase() === currentStore.name.toLowerCase() || row.toko === currentStore.id;
      if (!matches) { tokoFilteredOut++; continue; }
    }
    const key = row.barcode || (row.pcode ? 'PC-' + row.pcode : null);
    if (!key) { invalidRow++; continue; }

    let product = lookup[key];
    if (!product) {
      product = {
        pcode: row.pcode || null,
        barcode: row.barcode || null,
        name: row.namaProduk || `Produk (${key})`,
        flag: null,
        isi: null,
        rsp: null
      };
      lookup[key] = product;
      newProducts.push(product);
      adHocCount++;
    }
    if (!itemsMap[key]) itemsMap[key] = { productName: product.name };

    if (row.jenis === 'unilever') {
      itemsMap[key].unileverPrice = row.harga;
      unileverCount++;
    } else {
      const compList = competitors[key] || {};
      const targetName = row.namaKompetitor.toLowerCase();
      const cid = Object.keys(compList).find(id => {
        const c = compList[id];
        return `${c.brand} - ${c.productName}`.toLowerCase() === targetName || c.brand.toLowerCase() === targetName;
      });
      if (!cid) { unmatchedCompetitor++; continue; }
      if (!itemsMap[key].competitorPrices) itemsMap[key].competitorPrices = {};
      itemsMap[key].competitorPrices[cid] = row.harga;
      competitorCount++;
    }
  }
  return { itemsMap, newProducts, unileverCount, competitorCount, adHocCount, unmatchedCompetitor, tokoFilteredOut, invalidRow };
}

async function onPriceUploadSave() {
  if (!pendingPriceParse) return;
  const btn = el('priceSaveBtn');
  const original = btn.textContent;
  btn.textContent = 'Menyimpan...';
  btn.disabled = true;
  try {
    await saveBulkPriceEntries(currentStore, currentPeriodKey, pendingPriceParse.itemsMap);
    // Produk baru (di luar SKU wajib/promo) langsung masuk daftar tampilan tanpa perlu reload
    if (pendingPriceParse.newProducts.length) {
      allProducts = allProducts.concat(pendingPriceParse.newProducts).sort((a, b) => a.name.localeCompare(b.name));
    }
    // Update tampilan lokal supaya langsung kelihatan tanpa perlu reload
    for (const [key, val] of Object.entries(pendingPriceParse.itemsMap)) {
      if (!currentEntry[key]) currentEntry[key] = {};
      if (val.unileverPrice !== undefined) currentEntry[key].unileverPrice = val.unileverPrice;
      if (val.competitorPrices) {
        if (!currentEntry[key].competitorPrices) currentEntry[key].competitorPrices = {};
        Object.assign(currentEntry[key].competitorPrices, val.competitorPrices);
      }
    }
    showToast(`Harga dari file berhasil disimpan (${pendingPriceParse.unileverCount + pendingPriceParse.competitorCount} entri, ${pendingPriceParse.newProducts.length} produk baru).`, 'success');
    pendingPriceParse = null;
    el('priceFileInput').value = '';
    el('priceParsePreview').textContent = '';
    el('priceParseDetail').innerHTML = '';
    renderProgress();
    renderProductList();
  } catch (err) {
    console.error('Gagal menyimpan harga dari file:', err);
    showToast(`Gagal menyimpan (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

let toastTimer;
function showToast(message, type) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3200);
}

// Export 1 toko: SEMUA bulan yang pernah diisi. Nama/flag/RSP produk dicocokkan dari
// daftar produk yang sedang termuat (allProducts) -- untuk SKU wajib selalu akurat,
// untuk SKU promo dari bulan LAIN yang sudah beda daftar promo-nya bisa kosong namanya
// (PC Code tetap ada sebagai identitas).
async function exportOneStorePrice() {
  if (!currentStore) return;
  const btn = el('exportStoreBtn');
  const original = btn.textContent;
  btn.textContent = 'Menyiapkan...';
  btn.disabled = true;
  try {
    const lookup = Object.fromEntries(allProducts.map(p => [priceKey(p), p]));
    const q = query(collection(db, 'priceEntries'), where('storeId', '==', currentStore.id));
    const snap = await getDocs(q);
    const rows = [];
    snap.forEach(d => {
      const data = d.data();
      const items = data.items || {};
      for (const [key, it] of Object.entries(items)) {
        appendPriceRows(rows, currentStore, data.periodKey, key, it, lookup[key]);
      }
    });
    if (!rows.length) {
      alert(`Belum ada data harga untuk ${currentStore.name}.`);
      return;
    }
    downloadAsExcel(rows, `survei_harga_${currentStore.name.replace(/[^a-z0-9]+/gi, '_')}.xlsx`, 'Survei Harga');
  } catch (err) {
    console.error('Gagal export survei harga toko:', err);
    alert('Gagal export: ' + (err.message || err));
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

// Export semua toko (10 toko survei harga): cuma untuk bulan yang sedang dipilih.
async function exportAllStoresPrice() {
  const btn = el('exportAllPriceBtn');
  const original = btn.textContent;
  btn.textContent = 'Menyiapkan...';
  btn.disabled = true;
  try {
    const q = query(collection(db, 'priceEntries'), where('periodKey', '==', currentPeriodKey));
    const snap = await getDocs(q);
    const rows = [];
    const lookupCache = {};
    for (const d of snap.docs) {
      const data = d.data();
      const store = ecBigStores.find(s => s.id === data.storeId);
      if (!store) continue;
      if (!lookupCache[store.scopeSlug]) {
        const wajib = await loadSkuList(store.scopeSlug);
        const promoDoc = await loadPromoSku(store.scopeSlug, currentPeriodKey);
        lookupCache[store.scopeSlug] = mergeProducts(wajib, promoDoc);
      }
      const lookup = Object.fromEntries(lookupCache[store.scopeSlug].map(p => [priceKey(p), p]));
      const items = data.items || {};
      for (const [key, it] of Object.entries(items)) {
        appendPriceRows(rows, store, data.periodKey, key, it, lookup[key]);
      }
    }
    if (!rows.length) {
      alert('Belum ada data harga untuk bulan ini.');
      return;
    }
    downloadAsExcel(rows, `survei_harga_semua_toko_${currentPeriodKey}.xlsx`, 'Survei Harga');
  } catch (err) {
    console.error('Gagal export survei harga semua toko:', err);
    alert('Gagal export: ' + (err.message || err));
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

// Tambahkan baris mentah (1 baris per harga -- Unilever atau tiap kompetitor) ke array rows.
function appendPriceRows(rows, store, periodKey, key, it, meta) {
  meta = meta || {};
  if (it.unileverPrice !== undefined && it.unileverPrice !== '' && it.unileverPrice !== null) {
    rows.push({
      Toko: store.name, Area: store.area, Bulan: periodKey,
      Barcode: meta.barcode || key, PCCode: meta.pcode || '', NamaProduk: meta.name || '',
      Flag: meta.flag || 'Promo', RSP: meta.rsp || '',
      JenisHarga: 'Unilever', NamaKompetitor: '', UkuranKemasanKompetitor: '',
      Harga: it.unileverPrice
    });
  }
  const compPrices = it.competitorPrices || {};
  for (const [cid, price] of Object.entries(compPrices)) {
    if (price === '' || price === undefined || price === null) continue;
    const c = (competitors[key] || {})[cid] || {};
    rows.push({
      Toko: store.name, Area: store.area, Bulan: periodKey,
      Barcode: meta.barcode || key, PCCode: meta.pcode || '', NamaProduk: meta.name || '',
      Flag: meta.flag || 'Promo', RSP: meta.rsp || '',
      JenisHarga: 'Kompetitor', NamaKompetitor: c.brand ? `${c.brand} - ${c.productName || ''}` : '', UkuranKemasanKompetitor: c.packSize || '',
      Harga: price
    });
  }
}

init();
