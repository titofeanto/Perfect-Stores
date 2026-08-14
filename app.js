import { db, doc, getDoc, setDoc, serverTimestamp, authReady } from './firebase-init.js';
import { loadStores, loadSkuList, groupStoresByArea } from './store-data.js';
import { getWeeksForMonth, findWeekContaining, fmtShort, MONTHS_ID, addDays, isoDate } from './weeks.js';
import { loadDistributorStock, parseDistributorWorkbook, saveDistributorStock } from './stock-upload.js';
import { supportsNativeBarcodeDetector, startNativeScan, stopNativeScan, startFallbackScan, stopFallbackScan } from './barcode-scan.js';
import { parsePurchaseWorkbook } from './purchase-upload.js';
import { FIELDS, EDITABLE_FIELDS, fieldTotal, fieldIsEmpty, normalizeField, statusOf } from './entry-utils.js';

const FIELD_LABELS = { stock: 'Stock', order: 'Order', masuk: 'Masuk', jual: 'Jual' };
const FLAG_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD' };
const FLAG_CLASS = { 'COTC': 'flag-cotc', 'MARKET MAKING': 'flag-market', 'NPD': 'flag-npd' };

const TODAY = new Date(); // tanggal perangkat SBA saat app dibuka

let stores = [];
let storesByArea = {};
let currentStore = null;
let currentSkuList = [];
let currentEntry = {}; // { [barcode]: {stock,order,masuk,jual} }
let currentEntryDocId = null;
let currentWeeks = [];
let currentWeek = null;
let flagFilter = 'all';
let searchText = '';
let distributorCache = {}; // area -> { items: {pcode: {...}} }
let saveTimers = {};
let currentTab = 'input';

const el = (id) => document.getElementById(id);

// Satu sub-field {karton, lusin, pcs} -> total pcs. 1 lusin selalu = 12 pcs.
// (fieldTotal, fieldIsEmpty, normalizeField, statusOf sekarang diimpor dari entry-utils.js)

// Referensi bantu SBA menentukan Order: perkiraan penjualan minggu lalu,
// dihitung langsung (live) dari Stock minggu lalu + Masuk minggu lalu - Stock minggu ini
// (yang sedang diketik, belum perlu submit dulu). Ini cuma tampilan bantu, bukan Jual resmi.
function orderRefHtml(sku, item) {
  const prevRaw = previousWeekItems[sku.barcode];
  const prevStock = prevRaw ? normalizeField(prevRaw.stock) : null;
  if (!prevStock || fieldIsEmpty(prevStock)) return '';
  if (fieldIsEmpty(item.stock)) {
    return '<p class="order-ref-note">Isi Stock dulu untuk lihat referensi penjualan minggu lalu</p>';
  }
  const prevMasuk = normalizeField(prevRaw.masuk);
  const qty = fieldTotal(prevStock, sku.isi) + fieldTotal(prevMasuk, sku.isi) - fieldTotal(item.stock, sku.isi);
  const masukNote = fieldIsEmpty(prevMasuk) ? ' &middot; Barang Masuk minggu lalu belum diisi Supervisor (dianggap 0)' : '';
  return `<p class="order-ref-note order-ref-value">Referensi: perkiraan penjualan minggu lalu &asymp; <strong>${qty} pcs</strong>${masukNote}</p>`;
}

function badgeHtml(sku, item) {
  const s = statusOf(item);
  let html = `<span class="badge ${FLAG_CLASS[sku.flag] || 'flag-cotc'}">${FLAG_LABELS[sku.flag] || sku.flag}</span>`;
  if (s === 'lengkap') html += '<span class="badge lengkap">Lengkap</span>';
  else if (s === 'partial') html += '<span class="badge partial">Belum lengkap</span>';
  else html += '<span class="badge kosong">Belum diisi</span>';
  if (!fieldIsEmpty(item.stock) && fieldTotal(item.stock, sku.isi) === 0) {
    html += '<span class="badge stockzero">Tidak ada</span>';
  }
  if (s !== 'lengkap') html += '<div class="sku-warning">Kolom kosong akan tercatat 0 saat dikirim</div>';
  return html;
}

// ---------- Init ----------

async function init() {
  await authReady;
  stores = await loadStores();
  storesByArea = groupStoresByArea(stores);

  populateAreaSelect();
  populateMonthSelect();
  attachStaticHandlers();

  await applyUrlParamsAndLoad();
}

// Dashboard rekap lintas toko mengirim link seperti index.html?store=<id>&period=<YYYY-MM-DD>
// supaya supervisor bisa klik "Buka" dan langsung diarahkan ke toko + minggu yang tepat.
async function applyUrlParamsAndLoad() {
  const params = new URLSearchParams(window.location.search);
  const paramStore = params.get('store') ? stores.find(s => s.id === params.get('store')) : null;
  const paramPeriod = params.get('period');

  if (paramStore) {
    el('areaSel').value = paramStore.area;
    populateStoreSelect(paramStore.area);
    el('storeSel').value = paramStore.id;
  } else {
    populateStoreSelect(el('areaSel').value);
  }

  if (paramPeriod) {
    const periodDate = new Date(paramPeriod + 'T00:00:00');
    if (!isNaN(periodDate)) {
      const monthValue = `${periodDate.getFullYear()}-${periodDate.getMonth()}`;
      if (![...el('monthSel').options].some(o => o.value === monthValue)) {
        const opt = document.createElement('option');
        opt.value = monthValue;
        opt.textContent = `${MONTHS_ID[periodDate.getMonth()]} ${periodDate.getFullYear()}`;
        el('monthSel').appendChild(opt);
      }
      el('monthSel').value = monthValue;
    }
  }

  await onStoreChange(paramPeriod || undefined);
  if (paramStore) showToast(`Dibuka dari dashboard: ${paramStore.name}`, 'success');
}

function populateAreaSelect() {
  const areas = Object.keys(storesByArea).sort();
  el('areaSel').innerHTML = areas.map(a => `<option value="${a}">${a}</option>`).join('');
}

function populateStoreSelect(area) {
  const list = storesByArea[area] || [];
  el('storeSel').innerHTML = list
    .map(s => `<option value="${s.id}">${s.name}</option>`)
    .join('');
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
    .map(o => `<option value="${o.y}-${o.m}">${MONTHS_ID[o.m]} ${o.y}</option>`)
    .join('');
  el('monthSel').value = `${y}-${m}`;
}

function populateWeekSelect(preferPeriodKey) {
  const [y, m] = el('monthSel').value.split('-').map(Number);
  currentWeeks = getWeeksForMonth(y, m);
  el('weekSel').innerHTML = currentWeeks
    .map((w, i) => `<option value="${i}">${w.label} (${fmtShort(w.start)} - ${fmtShort(w.end)})</option>`)
    .join('');
  let idx = -1;
  if (preferPeriodKey) idx = currentWeeks.findIndex(w => w.periodKey === preferPeriodKey);
  if (idx === -1) idx = findWeekContaining(currentWeeks, TODAY);
  if (idx === -1) idx = 0;
  el('weekSel').value = idx;
  currentWeek = currentWeeks[idx];
}

// ---------- Event wiring ----------

function attachStaticHandlers() {
  el('areaSel').addEventListener('change', onAreaChange);
  el('storeSel').addEventListener('change', () => onStoreChange());
  el('monthSel').addEventListener('change', onPeriodChange);
  el('weekSel').addEventListener('change', onPeriodChange);
  el('searchBox').addEventListener('input', (e) => { searchText = e.target.value; renderSkuList(); });

  el('tabInput').addEventListener('click', () => switchTab('input'));
  el('tabRecap').addEventListener('click', () => switchTab('recap'));
  el('tabStock').addEventListener('click', () => switchTab('stock'));
  el('tabMasuk').addEventListener('click', () => switchTab('masuk'));

  el('modalReview').addEventListener('click', () => { hideModal(); switchTab('input'); });
  el('modalConfirm').addEventListener('click', onConfirmSubmit);

  el('stockAreaSel').addEventListener('change', refreshStockTab);
  el('stockFileInput').addEventListener('change', onStockFileSelected);
  el('stockSaveBtn').addEventListener('click', onStockSave);
  el('masukFileInput').addEventListener('change', onMasukFileSelected);
  el('masukSaveBtn').addEventListener('click', onMasukSave);

  el('scanBtn').addEventListener('click', openScanModal);
  el('scanCloseBtn').addEventListener('click', closeScanModal);
}

async function onAreaChange() {
  populateStoreSelect(el('areaSel').value);
  await onStoreChange();
}

async function onStoreChange(preferPeriodKey) {
  const storeId = el('storeSel').value;
  currentStore = stores.find(s => s.id === storeId);
  if (!currentStore) return;
  el('scopeInfo').textContent = `Scope channel: ${currentStore.scopeChannel} (${currentStore.subChannel})`;
  currentSkuList = await loadSkuList(currentStore.scopeSlug);
  populateWeekSelect(preferPeriodKey);
  await Promise.all([
    loadEntryForCurrentPeriod(),
    ensureDistributorStockLoaded(currentStore.area)
  ]);
  renderAll();
}

// Data stock distributor dimuat sekali per area lalu di-cache di memori.
// Dulu ini cuma dimuat kalau tab "Stock distributor" dibuka -- akibatnya
// SBA yang langsung ke tab Input tidak pernah melihat info stock distributor
// walau datanya sudah ada di database. Sekarang dimuat otomatis begitu toko dipilih.
async function ensureDistributorStockLoaded(area) {
  if (distributorCache[area] !== undefined) return;
  try {
    distributorCache[area] = await loadDistributorStock(area);
  } catch (err) {
    console.error('Gagal memuat stock distributor:', err);
    distributorCache[area] = null;
  }
}

async function onPeriodChange() {
  populateWeekSelect();
  await loadEntryForCurrentPeriod();
  renderAll();
}

function switchTab(tab) {
  currentTab = tab;
  el('tabInput').classList.toggle('active', tab === 'input');
  el('tabRecap').classList.toggle('active', tab === 'recap');
  el('tabStock').classList.toggle('active', tab === 'stock');
  el('tabMasuk').classList.toggle('active', tab === 'masuk');
  el('viewInput').classList.toggle('hidden', tab !== 'input');
  el('viewRecap').classList.toggle('hidden', tab !== 'recap');
  el('viewStock').classList.toggle('hidden', tab !== 'stock');
  el('viewMasuk').classList.toggle('hidden', tab !== 'masuk');
  el('searchBox').style.display = tab === 'input' ? 'block' : 'none';
  el('flagFilterRow').style.display = tab === 'input' ? 'flex' : 'none';
  if (tab === 'recap') renderRecap();
  if (tab === 'stock') refreshStockTab();
  if (tab === 'masuk') refreshMasukTab();
}

// ---------- Firestore load/save for entries ----------

function entryDocId(store, week) {
  return `${store.id}__${week.periodKey}`;
}

let previousWeekItems = {};

async function loadEntryForCurrentPeriod() {
  currentEntryDocId = entryDocId(currentStore, currentWeek);
  const ref = doc(db, 'entries', currentEntryDocId);
  const prevPeriodKey = isoDate(addDays(currentWeek.start, -7));
  const prevRef = doc(db, 'entries', `${currentStore.id}__${prevPeriodKey}`);
  let snap, prevSnap;
  try {
    [snap, prevSnap] = await Promise.all([getDoc(ref), getDoc(prevRef)]);
  } catch (err) {
    console.error('Gagal memuat data minggu ini/minggu lalu:', err);
    snap = null; prevSnap = null;
  }
  const saved = snap && snap.exists() ? (snap.data().items || {}) : {};
  previousWeekItems = prevSnap && prevSnap.exists() ? (prevSnap.data().items || {}) : {};
  currentEntry = {};
  for (const sku of currentSkuList) {
    const savedItem = saved[sku.barcode] || {};
    const entry = {};
    for (const f of FIELDS) entry[f] = normalizeField(savedItem[f]);
    currentEntry[sku.barcode] = entry;
  }
}

function scheduleSaveField(barcode) {
  clearTimeout(saveTimers[barcode]);
  saveTimers[barcode] = setTimeout(() => saveField(barcode), 600);
}

async function saveField(barcode) {
  const sku = currentSkuList.find(s => s.barcode === barcode);
  const itemToSave = {};
  // Cuma Stock & Order yang ditulis dari sini -- Masuk & Jual sengaja TIDAK disentuh
  // supaya tidak menimpa data yang nanti diisi lewat upload pembelian toko oleh Supervisor
  // atau hasil hitung otomatis.
  for (const f of EDITABLE_FIELDS) {
    const fo = currentEntry[barcode][f];
    itemToSave[f] = { karton: fo.karton, lusin: fo.lusin, pcs: fo.pcs, total: fieldTotal(fo, sku.isi) };
  }
  const ref = doc(db, 'entries', currentEntryDocId);
  try {
    await setDoc(ref, {
      storeId: currentStore.id,
      storeName: currentStore.name,
      area: currentStore.area,
      scopeSlug: currentStore.scopeSlug,
      periodKey: currentWeek.periodKey,
      weekStart: currentWeek.start.toISOString(),
      weekEnd: currentWeek.end.toISOString(),
      items: { [barcode]: itemToSave },
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('Gagal menyimpan field:', err);
    showToast('Gagal menyimpan perubahan. Cek koneksi internet.', 'danger');
  }
}

async function submitAllZeroFilled() {
  const itemsToSave = {};
  for (const sku of currentSkuList) {
    const item = currentEntry[sku.barcode];
    const filled = {};
    // Cuma Stock & Order yang di-zero-fill dan dikirim -- Masuk & Jual dibiarkan
    // apa adanya (diisi dari sumber lain: upload Supervisor / hitung otomatis).
    for (const f of EDITABLE_FIELDS) {
      const fo = item[f];
      const normalized = {
        karton: fo.karton === '' ? 0 : fo.karton,
        lusin: fo.lusin === '' ? 0 : fo.lusin,
        pcs: fo.pcs === '' ? 0 : fo.pcs
      };
      normalized.total = fieldTotal(normalized, sku.isi);
      item[f] = normalized;
      filled[f] = normalized;
    }
    itemsToSave[sku.barcode] = filled;
  }
  const ref = doc(db, 'entries', currentEntryDocId);
  await setDoc(ref, {
    storeId: currentStore.id,
    storeName: currentStore.name,
    area: currentStore.area,
    scopeSlug: currentStore.scopeSlug,
    periodKey: currentWeek.periodKey,
    weekStart: currentWeek.start.toISOString(),
    weekEnd: currentWeek.end.toISOString(),
    items: itemsToSave,
    submitted: true,
    submittedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

// ---------- Rendering ----------

function renderAll() {
  renderReminder();
  renderProgress();
  renderFlagFilterChips();
  renderSkuList();
  if (currentTab === 'recap') renderRecap();
}

function renderReminder() {
  const banner = el('reminderBanner');
  const missing = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) !== 'lengkap').length;
  const range = `${fmtShort(currentWeek.start)} - ${fmtShort(currentWeek.end)}`;
  banner.className = 'banner';
  if (missing === 0) {
    banner.classList.add('success');
    banner.textContent = `${currentWeek.label} (${range}) sudah lengkap.`;
    return;
  }
  if (TODAY < currentWeek.start) {
    banner.classList.add('info');
    banner.textContent = `${currentWeek.label} (${range}) belum dimulai.`;
    return;
  }
  if (TODAY > currentWeek.end) {
    banner.classList.add('danger');
    banner.textContent = `Terlewat: ${currentWeek.label} berakhir ${fmtShort(currentWeek.end)}. Masih ada ${missing} SKU belum lengkap.`;
    return;
  }
  const daysLeft = Math.ceil((currentWeek.end - TODAY) / 86400000) + 1;
  banner.classList.add('warning');
  banner.textContent = `Pengingat: ${currentWeek.label} berakhir dalam ${daysLeft} hari (${fmtShort(currentWeek.end)}). Masih ada ${missing} SKU belum lengkap.`;
}

function renderProgress() {
  const total = currentSkuList.length;
  const lengkap = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) === 'lengkap').length;
  const pct = total ? Math.round((lengkap / total) * 100) : 0;
  el('progLabel').textContent = `${lengkap}/${total} SKU lengkap`;
  el('progPct').textContent = pct + '%';
  el('progBar').style.width = pct + '%';
  const missing = total - lengkap;
  el('recapBadge').style.display = missing > 0 ? 'inline-block' : 'none';
  el('recapBadge').textContent = missing;
}

function renderFlagFilterChips() {
  const flags = ['all', 'COTC', 'MARKET MAKING', 'NPD'];
  el('flagFilterRow').innerHTML = flags.map(f => {
    const label = f === 'all' ? 'Semua' : (FLAG_LABELS[f] || f);
    return `<span class="chip ${flagFilter === f ? 'active' : ''}" data-flag="${f}">${label}</span>`;
  }).join('');
  el('flagFilterRow').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      flagFilter = chip.dataset.flag;
      el('flagFilterRow').querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('active', c.dataset.flag === flagFilter);
      });
      renderSkuList();
    });
  });
}

function renderSkuList() {
  const q = searchText.toLowerCase();
  const distStock = distributorCache[currentStore.area];
  const filtered = currentSkuList.filter(sku => {
    if (flagFilter !== 'all' && sku.flag !== flagFilter) return false;
    if (q && !sku.name.toLowerCase().includes(q) && !sku.barcode.includes(q)) return false;
    return true;
  });

  el('skuList').innerHTML = filtered.map(sku => {
    const item = currentEntry[sku.barcode];
    let distHint = '';
    if (distStock && sku.pcode && distStock.items[sku.pcode]) {
      const d = distStock.items[sku.pcode];
      distHint = `<div class="sku-distributor">Stock distributor (${currentStore.area}): ${d.karton} karton, ${d.lusin} lusin, ${d.pcs} pcs</div>`;
    }
    const isiNote = sku.isi
      ? `<p class="sku-isi">1 karton = ${sku.isi} pcs &middot; 1 lusin = 12 pcs</p>`
      : `<p class="sku-isi sku-isi-missing">Isi per karton tidak diketahui untuk SKU ini &mdash; gunakan Lusin/Pcs</p>`;
    return `
      <div class="sku-item" data-barcode="${sku.barcode}">
        <p class="sku-name">${sku.name}</p>
        <p class="sku-code">${sku.barcode}${sku.pcode ? ' &middot; PC ' + sku.pcode : ''}</p>
        <div class="sku-badges">${badgeHtml(sku, item)}</div>
        ${distHint}
        ${isiNote}
        <div class="field-subheader">
          <span>Karton</span><span>Lusin</span><span>Pcs</span>
        </div>
        <div class="field-list" style="margin-top:2px;">
          ${EDITABLE_FIELDS.map(f => {
            const fo = item[f];
            const total = fieldTotal(fo, sku.isi);
            const kartonAttrs = sku.isi ? '' : 'disabled title="Isi per karton tidak diketahui untuk SKU ini"';
            return `
              ${f === 'order' ? `<div class="order-ref" data-order-ref-for="${sku.barcode}">${orderRefHtml(sku, item)}</div>` : ''}
              <div class="field-row">
                <div class="field-row-head">
                  <label class="field-label">${FIELD_LABELS[f]}</label>
                  <span class="field-total" data-total-for="${f}">= ${total} pcs</span>
                </div>
                <div class="field-subinputs">
                  <input type="number" min="0" data-barcode="${sku.barcode}" data-field="${f}" data-sub="karton" value="${fo.karton}" placeholder="Krtn" ${kartonAttrs}>
                  <input type="number" min="0" data-barcode="${sku.barcode}" data-field="${f}" data-sub="lusin" value="${fo.lusin}" placeholder="Lsn">
                  <input type="number" min="0" data-barcode="${sku.barcode}" data-field="${f}" data-sub="pcs" value="${fo.pcs}" placeholder="Pcs">
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ${(() => {
          if (!fieldIsEmpty(item.jual)) {
            const jualQty = fieldTotal(item.jual, sku.isi);
            return `<p class="sku-isi sku-jual-computed">Penjualan (dihitung otomatis): <strong>${jualQty} pcs</strong></p>`;
          }
          return '<p class="sku-isi" style="margin-top:6px;">Barang Masuk diisi Supervisor &middot; Penjualan dihitung otomatis setelah minggu depan diisi</p>';
        })()}
      </div>
    `;
  }).join('') || '<p class="upload-status">Tidak ada produk yang cocok.</p>';

  el('skuList').querySelectorAll('.field-subinputs input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const barcode = inp.dataset.barcode;
      const field = inp.dataset.field;
      const sub = inp.dataset.sub;
      currentEntry[barcode][field][sub] = inp.value;
      scheduleSaveField(barcode);
      renderProgress();
      renderReminder();
      const container = inp.closest('.sku-item');
      const sku = currentSkuList.find(s => s.barcode === barcode);
      container.querySelector('.sku-badges').innerHTML = badgeHtml(sku, currentEntry[barcode]);
      const totalEl = container.querySelector(`[data-total-for="${field}"]`);
      if (totalEl) totalEl.textContent = `= ${fieldTotal(currentEntry[barcode][field], sku.isi)} pcs`;
      if (field === 'stock') {
        const refEl = container.querySelector(`[data-order-ref-for="${barcode}"]`);
        if (refEl) refEl.innerHTML = orderRefHtml(sku, currentEntry[barcode]);
      }
    });
  });
}

function renderRecap() {
  const total = currentSkuList.length;
  const lengkap = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) === 'lengkap').length;
  const belum = total - lengkap;
  const tidakAda = currentSkuList.filter(sku => {
    const stockField = currentEntry[sku.barcode].stock;
    return !fieldIsEmpty(stockField) && fieldTotal(stockField, sku.isi) === 0;
  }).length;

  let html = `
    <div class="metric-grid">
      <div class="metric-card"><div class="label">Total SKU wajib</div><div class="value">${total}</div></div>
      <div class="metric-card"><div class="label">Lengkap</div><div class="value">${lengkap}</div></div>
      <div class="metric-card"><div class="label">Belum lengkap</div><div class="value">${belum}</div></div>
      <div class="metric-card"><div class="label">Tidak ada di toko</div><div class="value">${tidakAda}</div></div>
    </div>
  `;

  const missing = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) !== 'lengkap');
  if (missing.length) {
    html += '<p class="section-title">Perlu ditindaklanjuti</p>';
    html += missing.map(sku => `
      <div class="sku-item">
        <p class="sku-name">${sku.name}</p>
        <div>${badgeHtml(sku, currentEntry[sku.barcode])}</div>
      </div>
    `).join('');
  }

  html += '<button id="submitBtn" class="primary" style="width:100%; margin-top:12px;">Konfirmasi dan kirim</button>';
  el('viewRecap').innerHTML = html;
  el('submitBtn').addEventListener('click', onSubmitClick);
}

function onSubmitClick() {
  const total = currentSkuList.length;
  const lengkap = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) === 'lengkap').length;
  const missing = total - lengkap;
  const emptyFields = currentSkuList.reduce((n, sku) => {
    const item = currentEntry[sku.barcode];
    return n + EDITABLE_FIELDS.filter(f => fieldIsEmpty(item[f])).length;
  }, 0);
  if (missing > 0) {
    el('modalBody').textContent = `${missing} dari ${total} SKU wajib untuk ${currentWeek.label} belum lengkap, dengan total ${emptyFields} kolom kosong. Kolom kosong akan otomatis tercatat 0 jika Anda kirim sekarang.`;
  } else {
    el('modalBody').textContent = `Semua SKU wajib untuk ${currentWeek.label} sudah lengkap. Data siap dikirim.`;
  }
  showModal();
}

async function onConfirmSubmit() {
  const btn = el('modalConfirm');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Mengirim...';
  try {
    await submitAllZeroFilled();
    hideModal();
    renderAll();
    renderRecap();
    showToast(`Berhasil dikirim untuk ${currentWeek.label}, ${currentStore.name}`, 'success');
    // Setelah stock minggu ini tersimpan, coba hitung ulang Jual minggu SEBELUMNYA
    // (kalau minggu sebelumnya sudah ada datanya).
    const prevWeekStart = addDays(currentWeek.start, -7);
    computeAndSaveJualForStorePeriod(currentStore.id, prevWeekStart, currentSkuList).catch(err => {
      console.error('Gagal hitung ulang Jual minggu sebelumnya:', err);
    });
  } catch (err) {
    console.error('Gagal mengirim:', err);
    showToast('Gagal mengirim. Cek koneksi internet lalu coba lagi.', 'danger');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

let usingNativeScan = false;

async function openScanModal() {
  if (!currentSkuList.length) {
    showToast('Pilih toko dulu sebelum scan.', 'danger');
    return;
  }
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
  const sku = currentSkuList.find(s => s.barcode === barcode);
  if (!sku) {
    showToast(`Barcode ${barcode} tidak ada di SKU wajib toko ini.`, 'danger');
    return;
  }
  switchTab('input');
  flagFilter = 'all';
  searchText = barcode;
  el('searchBox').value = barcode;
  renderFlagFilterChips();
  renderSkuList();
  const card = document.querySelector(`.sku-item[data-barcode="${barcode}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash-highlight');
    setTimeout(() => card.classList.remove('flash-highlight'), 1600);
  }
  showToast(`Ditemukan: ${sku.name}`, 'success');
}

// ---------- Hitung otomatis Penjualan ----------
// Rumus: Jual minggu N = Stock minggu N + Barang Masuk minggu N - Stock minggu N+1.
// Baru bisa dihitung setelah Stock minggu N+1 (minggu depannya) sudah diisi.
// Dipanggil dari 2 arah: (1) setelah SBA submit stock minggu ini -> hitung ulang
// Jual minggu SEBELUMNYA, dan (2) setelah Supervisor upload Barang Masuk untuk
// suatu minggu -> hitung ulang Jual minggu itu (kalau stock minggu depannya sudah ada).
async function computeAndSaveJualForStorePeriod(storeId, weekStart, skuList) {
  const periodKey = isoDate(weekStart);
  const nextPeriodKey = isoDate(addDays(weekStart, 7));
  let curSnap, nextSnap;
  try {
    [curSnap, nextSnap] = await Promise.all([
      getDoc(doc(db, 'entries', `${storeId}__${periodKey}`)),
      getDoc(doc(db, 'entries', `${storeId}__${nextPeriodKey}`))
    ]);
  } catch (err) {
    console.error('Gagal mengambil data untuk hitung Jual:', err);
    return 0;
  }
  if (!curSnap.exists() || !nextSnap.exists()) return 0;
  const curItems = curSnap.data().items || {};
  const nextItems = nextSnap.data().items || {};
  const updates = {};
  let count = 0;
  for (const sku of skuList) {
    const stockN = normalizeField((curItems[sku.barcode] || {}).stock);
    if (fieldIsEmpty(stockN)) continue;
    const stockN1 = normalizeField((nextItems[sku.barcode] || {}).stock);
    if (fieldIsEmpty(stockN1)) continue;
    const masukN = normalizeField((curItems[sku.barcode] || {}).masuk);
    const jualQty = fieldTotal(stockN, sku.isi) + fieldTotal(masukN, sku.isi) - fieldTotal(stockN1, sku.isi);
    updates[sku.barcode] = {
      jual: { karton: '0', lusin: '0', pcs: String(jualQty), masukIncluded: !fieldIsEmpty(masukN) }
    };
    count++;
  }
  if (count > 0) {
    try {
      await setDoc(doc(db, 'entries', `${storeId}__${periodKey}`), { items: updates, jualComputedAt: serverTimestamp() }, { merge: true });
    } catch (err) {
      console.error('Gagal menyimpan hasil hitung Jual:', err);
      return 0;
    }
  }
  return count;
}
function hideModal() { el('modalBackdrop').classList.remove('show'); }
function showModal() { el('modalBackdrop').classList.add('show'); }

let toastTimer;
function showToast(message, type) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3200);
}

// ---------- Stock distributor tab ----------

let pendingStockParse = null;

async function refreshStockTab() {
  const area = el('stockAreaSel').value;
  el('stockSaveBtn').disabled = true;
  el('stockParsePreview').textContent = '';
  pendingStockParse = null;
  el('stockCurrentInfo').textContent = 'Memuat...';
  const existing = distributorCache[area] || await loadDistributorStock(area);
  if (existing) {
    distributorCache[area] = existing;
    const count = Object.keys(existing.items || {}).length;
    const ts = existing.uploadedAt && existing.uploadedAt.toDate ? existing.uploadedAt.toDate().toLocaleString('id-ID') : '-';
    el('stockCurrentInfo').textContent = `Data tersimpan: ${count} produk. Terakhir diupload: ${ts}. File: ${existing.sourceFileName || '-'}`;
  } else {
    el('stockCurrentInfo').textContent = 'Belum ada data stock distributor untuk area ini.';
  }
}

function onStockFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = parseDistributorWorkbook(ev.target.result);
      pendingStockParse = { ...parsed, fileName: file.name };
      el('stockParsePreview').textContent = `Berhasil dibaca: ${parsed.rowCount} produk terdeteksi (${parsed.skipped} baris dilewati).`;
      el('stockSaveBtn').disabled = false;
    } catch (err) {
      el('stockParsePreview').textContent = 'Gagal membaca file. Pastikan formatnya sesuai template.';
      el('stockSaveBtn').disabled = true;
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

async function onStockSave() {
  if (!pendingStockParse) return;
  const area = el('stockAreaSel').value;
  el('stockSaveBtn').disabled = true;
  el('stockSaveBtn').textContent = 'Menyimpan...';
  try {
    await saveDistributorStock(area, pendingStockParse.items, pendingStockParse.fileName);
    distributorCache[area] = { items: pendingStockParse.items, sourceFileName: pendingStockParse.fileName, uploadedAt: { toDate: () => new Date() } };
    showToast(`Stock distributor ${area} berhasil disimpan (${Object.keys(pendingStockParse.items).length} produk)`, 'success');
    await refreshStockTab();
    renderSkuList();
  } catch (err) {
    console.error('Gagal menyimpan stock distributor:', err);
    showToast('Gagal menyimpan. Cek koneksi internet lalu coba lagi.', 'danger');
  } finally {
    el('stockSaveBtn').textContent = 'Simpan ke database';
    el('stockSaveBtn').disabled = false;
  }
}

// ---------- Barang Masuk (upload pembelian toko dari distributor, oleh Supervisor) ----------

let pendingMasukResult = null;

function refreshMasukTab() {
  if (!currentWeek) return;
  el('masukPeriodInfo').textContent = `Periode target: ${currentWeek.label} (${fmtShort(currentWeek.start)} - ${fmtShort(currentWeek.end)})`;
  el('masukParsePreview').textContent = '';
  el('masukPreviewDetail').innerHTML = '';
  el('masukSaveBtn').disabled = true;
  pendingMasukResult = null;
}

// Cocokkan baris mentah hasil parsing ke toko (by Outlet=storeId) & SKU wajib toko itu
// (by SKUCode=PC Code), sambil membuang baris yang tanggalnya di luar minggu yang sedang dipilih.
async function processPurchaseRows(rows) {
  const weekStart = currentWeek.start;
  const weekEnd = currentWeek.end;
  let outOfRange = 0;
  const unmatchedStoreSet = new Set();
  let nonWajibCount = 0;
  const perStoreQty = {}; // storeId -> { barcode: totalQty }
  const pcodeMapCache = {}; // scopeSlug -> Map(pcode -> barcode)

  for (const row of rows) {
    if (row.invDate && (row.invDate < weekStart || row.invDate > weekEnd)) {
      outOfRange++;
      continue;
    }
    const store = stores.find(s => s.id === row.outlet);
    if (!store) {
      unmatchedStoreSet.add(row.outlet);
      continue;
    }
    if (!pcodeMapCache[store.scopeSlug]) {
      const skuList = await loadSkuList(store.scopeSlug);
      pcodeMapCache[store.scopeSlug] = new Map(skuList.filter(s => s.pcode).map(s => [s.pcode, s.barcode]));
    }
    const barcode = pcodeMapCache[store.scopeSlug].get(row.skuCode);
    if (!barcode) {
      nonWajibCount++;
      continue;
    }
    if (!perStoreQty[store.id]) perStoreQty[store.id] = {};
    perStoreQty[store.id][barcode] = (perStoreQty[store.id][barcode] || 0) + row.qty;
  }

  const matchedStoreNames = Object.keys(perStoreQty).map(id => (stores.find(s => s.id === id) || {}).name || id);
  return { perStoreQty, outOfRange, unmatchedStores: [...unmatchedStoreSet], nonWajibCount, matchedStoreNames, totalRows: rows.length };
}

function onMasukFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  el('masukParsePreview').textContent = 'Membaca file...';
  el('masukSaveBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const { rows, headerMissing } = parsePurchaseWorkbook(ev.target.result);
      if (headerMissing) {
        el('masukParsePreview').textContent = 'Format file tidak dikenali. Pastikan ada kolom Outlet, SKUCode, TotalQuantity(PCS).';
        return;
      }
      const result = await processPurchaseRows(rows);
      pendingMasukResult = result;
      const skuCombos = Object.values(result.perStoreQty).reduce((n, m) => n + Object.keys(m).length, 0);
      el('masukParsePreview').textContent = `${rows.length} baris dibaca. ${result.matchedStoreNames.length} toko terdeteksi, ${skuCombos} kombinasi toko+SKU siap disimpan.`;
      let detail = '';
      if (result.outOfRange > 0) detail += `<p class="upload-status">${result.outOfRange} baris di luar rentang ${currentWeek.label} diabaikan.</p>`;
      if (result.unmatchedStores.length) {
        const shown = result.unmatchedStores.slice(0, 8).join(', ');
        const more = result.unmatchedStores.length > 8 ? ` &middot; dan ${result.unmatchedStores.length - 8} kode outlet lain (di luar 36 toko SBA COTC)` : '';
        detail += `<p class="upload-status">${result.unmatchedStores.length} kode outlet tidak dikenal diabaikan: ${shown}${more}</p>`;
      }
      if (result.nonWajibCount > 0) detail += `<p class="upload-status">${result.nonWajibCount} baris di luar SKU wajib toko terkait diabaikan.</p>`;
      if (result.matchedStoreNames.length) detail += `<p class="upload-status">Toko terdeteksi: ${result.matchedStoreNames.join(', ')}</p>`;
      el('masukPreviewDetail').innerHTML = detail;
      el('masukSaveBtn').disabled = result.matchedStoreNames.length === 0;
    } catch (err) {
      console.error(err);
      el('masukParsePreview').textContent = 'Gagal membaca file. Pastikan formatnya sesuai.';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function onMasukSave() {
  if (!pendingMasukResult) return;
  const btn = el('masukSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  const result = pendingMasukResult;
  const periodKey = currentWeek.periodKey;
  const storeIds = Object.keys(result.perStoreQty);

  // Langkah 1: simpan ke Firestore. INI SATU-SATUNYA yang menentukan toast sukses/gagal.
  try {
    await Promise.all(storeIds.map(storeId => {
      const store = stores.find(s => s.id === storeId);
      const items = {};
      for (const [barcode, qty] of Object.entries(result.perStoreQty[storeId])) {
        items[barcode] = { masuk: { karton: '0', lusin: '0', pcs: String(qty) } };
      }
      const ref = doc(db, 'entries', `${storeId}__${periodKey}`);
      return setDoc(ref, {
        storeId,
        storeName: store ? store.name : storeId,
        area: store ? store.area : null,
        scopeSlug: store ? store.scopeSlug : null,
        periodKey,
        weekStart: currentWeek.start.toISOString(),
        weekEnd: currentWeek.end.toISOString(),
        items,
        masukUpdatedAt: serverTimestamp()
      }, { merge: true });
    }));
  } catch (err) {
    console.error('Gagal menyimpan barang masuk:', err);
    showToast(`Gagal menyimpan (${err.code || err.message || 'error tidak diketahui'}). Cek koneksi internet lalu coba lagi.`, 'danger');
    btn.textContent = 'Simpan ke database';
    btn.disabled = false;
    return;
  }

  showToast(`Barang masuk tersimpan untuk ${storeIds.length} toko, periode ${currentWeek.label}`, 'success');
  pendingMasukResult = null;
  el('masukFileInput').value = '';
  el('masukParsePreview').textContent = '';
  el('masukPreviewDetail').innerHTML = '';
  btn.textContent = 'Simpan ke database';
  btn.disabled = true;

  // Langkah 2: hitung ulang Jual (best-effort, tidak boleh mengubah toast di atas kalau gagal)
  Promise.all(storeIds.map(async storeId => {
    const store = stores.find(s => s.id === storeId);
    if (!store) return;
    const skuList = await loadSkuList(store.scopeSlug);
    return computeAndSaveJualForStorePeriod(storeId, currentWeek.start, skuList);
  })).catch(err => console.error('Gagal hitung ulang Jual setelah upload Masuk:', err));

  // Langkah 3: refresh tampilan toko yang sedang dibuka, kalau termasuk yang baru diupdate
  // (best-effort juga -- data sudah AMAN tersimpan di langkah 1, ini cuma soal tampilan).
  if (currentStore && result.perStoreQty[currentStore.id]) {
    try {
      await loadEntryForCurrentPeriod();
      renderAll();
    } catch (err) {
      console.error('Data tersimpan, tapi gagal me-refresh tampilan:', err);
    }
  }
}

init();
