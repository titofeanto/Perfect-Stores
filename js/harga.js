import { authReady } from './firebase-init.js';
import { loadStores, loadHargaProduk } from './store-data.js';
import { MONTHS_ID } from './weeks.js';
import { loadCompetitors, addCompetitor, updateCompetitor, loadPriceEntry, savePriceField } from './harga-data.js';
import { supportsNativeBarcodeDetector, startNativeScan, stopNativeScan, startFallbackScan, stopFallbackScan } from './barcode-scan.js';

const TODAY = new Date();
const el = (id) => document.getElementById(id);

const FLAG_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD' };
const FLAG_CLASS = { 'COTC': 'flag-cotc', 'MARKET MAKING': 'flag-market', 'NPD': 'flag-npd' };

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

function rp(n) {
  if (n === null || n === undefined || n === '') return '-';
  const num = Number(n);
  if (isNaN(num)) return '-';
  return 'Rp' + num.toLocaleString('id-ID');
}

async function init() {
  await authReady;
  const allStores = await loadStores();
  ecBigStores = allStores.filter(s => s.subChannel === 'LOCAL SUPERMARKET EC BIG');
  allProducts = await loadHargaProduk();
  competitors = await loadCompetitors();

  populateStoreSelect();
  populateMonthSelect();
  renderFlagFilterChips();

  el('storeSel').addEventListener('change', onStoreOrMonthChange);
  el('monthSel').addEventListener('change', onStoreOrMonthChange);
  el('searchBox').addEventListener('input', (e) => { searchText = e.target.value; renderProductList(); });
  el('scanBtn').addEventListener('click', openScanModal);
  el('scanCloseBtn').addEventListener('click', closeScanModal);

  await onStoreOrMonthChange();
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

async function onStoreOrMonthChange() {
  currentStore = ecBigStores.find(s => s.id === el('storeSel').value);
  currentPeriodKey = el('monthSel').value; // format YYYY-MM
  if (!currentStore) return;
  currentEntry = await loadPriceEntry(currentStore.id, currentPeriodKey);
  renderProgress();
  renderProductList();
}

function renderProgress() {
  const total = allProducts.length;
  const filled = allProducts.filter(p => {
    const e = currentEntry[p.pcode];
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

function renderProductList() {
  const q = searchText.trim().toLowerCase();
  const filtered = allProducts.filter(p => {
    if (flagFilter === 'PROMO' && p.flag) return false;
    if (flagFilter !== 'all' && flagFilter !== 'PROMO' && p.flag !== flagFilter) return false;
    if (q && !p.name.toLowerCase().includes(q) && !(p.barcode || '').includes(q) && !(p.pcode || '').includes(q)) return false;
    return true;
  });

  el('productList').innerHTML = filtered.map(p => {
    const entry = currentEntry[p.pcode] || {};
    const unileverPrice = entry.unileverPrice ?? '';
    const compList = competitors[p.pcode] || {};
    const compIds = Object.keys(compList);

    const compHtml = compIds.map(cid => {
      const c = compList[cid];
      const price = (entry.competitorPrices || {})[cid] ?? '';
      const isEditing = editingCompetitor && editingCompetitor.pcode === p.pcode && editingCompetitor.competitorId === cid;
      if (isEditing) {
        return `
          <div class="competitor-item">
            <div class="competitor-form" data-edit-form-for="${p.pcode}" data-edit-competitor-id="${cid}">
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
            <button type="button" class="competitor-edit-btn" data-edit-pcode="${p.pcode}" data-edit-cid="${cid}" title="Koreksi data kompetitor">Edit</button>
          </div>
          <div class="price-input-wrap">
            <span>Rp</span>
            <input type="number" min="0" data-pcode="${p.pcode}" data-kind="competitor" data-competitor-id="${cid}" value="${price}" placeholder="Harga di toko ini">
          </div>
        </div>
      `;
    }).join('');

    const formOpen = openAddForm === p.pcode;

    return `
      <div class="sku-item" data-pcode="${p.pcode}">
        <p class="sku-name">${p.name}</p>
        <p class="sku-code">${p.barcode || ''}${p.pcode ? ' &middot; PC ' + p.pcode : ''}</p>
        <div>${productBadge(p)}</div>
        ${p.rsp ? `<p class="rsp-note">RSP (saran harga jual): ${rp(p.rsp)}</p>` : ''}
        <div class="price-row">
          <div class="price-row-head"><label>Harga di toko ini (produk Unilever)</label></div>
          <div class="price-input-wrap">
            <span>Rp</span>
            <input type="number" min="0" data-pcode="${p.pcode}" data-kind="unilever" value="${unileverPrice}" placeholder="Harga jual di toko">
          </div>
        </div>
        <div class="competitor-section">
          ${compHtml}
          ${formOpen ? `
            <div class="competitor-form" data-form-for="${p.pcode}">
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
          ` : `<button type="button" class="add-competitor-btn" data-open-for="${p.pcode}">+ Tambah kompetitor</button>`}
        </div>
      </div>
    `;
  }).join('') || '<p class="upload-status">Tidak ada produk yang cocok.</p>';

  wireProductListEvents();
}

function wireProductListEvents() {
  el('productList').querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const pcode = inp.dataset.pcode;
      const kind = inp.dataset.kind;
      if (!currentEntry[pcode]) currentEntry[pcode] = {};
      if (kind === 'unilever') {
        currentEntry[pcode].unileverPrice = inp.value;
        scheduleSave(pcode, 'unilever', null, inp.value);
      } else {
        const cid = inp.dataset.competitorId;
        if (!currentEntry[pcode].competitorPrices) currentEntry[pcode].competitorPrices = {};
        currentEntry[pcode].competitorPrices[cid] = inp.value;
        scheduleSave(pcode, 'competitor', cid, inp.value);
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
      const pcode = form.dataset.formFor;
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
        const cid = await addCompetitor(pcode, { brand, productName, packSize });
        if (!competitors[pcode]) competitors[pcode] = {};
        competitors[pcode][cid] = { brand, productName, packSize };
        openAddForm = null;
        showToast(`Kompetitor "${brand}" ditambahkan -- langsung terlihat di semua toko lain.`, 'success');
        renderProductList();
      } catch (err) {
        console.error('Gagal menambah kompetitor:', err);
        showToast('Gagal menyimpan kompetitor. Cek koneksi internet.', 'danger');
        btn.disabled = false;
        btn.textContent = 'Simpan kompetitor';
      }
    });
  });

  el('productList').querySelectorAll('.competitor-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingCompetitor = { pcode: btn.dataset.editPcode, competitorId: btn.dataset.editCid };
      renderProductList();
    });
  });
  el('productList').querySelectorAll('.comp-edit-cancel').forEach(btn => {
    btn.addEventListener('click', () => { editingCompetitor = null; renderProductList(); });
  });
  el('productList').querySelectorAll('.comp-edit-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.competitor-form');
      const pcode = form.dataset.editFormFor;
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
        await updateCompetitor(pcode, cid, { brand, productName, packSize });
        competitors[pcode][cid] = { ...competitors[pcode][cid], brand, productName, packSize };
        editingCompetitor = null;
        showToast(`Data kompetitor "${brand}" dikoreksi -- langsung berubah di semua toko.`, 'success');
        renderProductList();
      } catch (err) {
        console.error('Gagal mengoreksi kompetitor:', err);
        showToast('Gagal menyimpan koreksi. Cek koneksi internet.', 'danger');
        btn.disabled = false;
        btn.textContent = 'Simpan koreksi';
      }
    });
  });
}

function scheduleSave(pcode, kind, competitorId, value) {
  const key = `${pcode}__${kind}__${competitorId || ''}`;
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(async () => {
    try {
      await savePriceField(currentStore, currentPeriodKey, pcode, kind, competitorId, value);
    } catch (err) {
      console.error('Gagal menyimpan harga:', err);
      showToast('Gagal menyimpan. Cek koneksi internet.', 'danger');
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
  const card = document.querySelector(`.sku-item[data-pcode="${product.pcode}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash-highlight');
    setTimeout(() => card.classList.remove('flash-highlight'), 1600);
  }
  showToast(`Ditemukan: ${product.name}`, 'success');
}

let toastTimer;
function showToast(message, type) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3200);
}

init();
