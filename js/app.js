import { db, doc, getDoc, setDoc, serverTimestamp, authReady } from './firebase-init.js';
import { loadStores, loadSkuList, groupStoresByArea } from './store-data.js';
import { getWeeksForMonth, findWeekContaining, fmtShort, MONTHS_ID } from './weeks.js';
import { loadDistributorStock, parseDistributorWorkbook, saveDistributorStock } from './stock-upload.js';

const FIELDS = ['stock', 'order', 'masuk', 'jual'];
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

function emptyEntryFor(barcode) {
  return { stock: '', order: '', masuk: '', jual: '' };
}

function statusOf(item) {
  const filled = FIELDS.filter(f => item[f] !== '' && item[f] !== undefined).length;
  if (filled === 4) return 'lengkap';
  if (filled === 0) return 'kosong';
  return 'partial';
}

function badgeHtml(sku, item) {
  const s = statusOf(item);
  let html = `<span class="badge ${FLAG_CLASS[sku.flag] || 'flag-cotc'}">${FLAG_LABELS[sku.flag] || sku.flag}</span>`;
  if (s === 'lengkap') html += '<span class="badge lengkap">Lengkap</span>';
  else if (s === 'partial') html += '<span class="badge partial">Belum lengkap</span>';
  else html += '<span class="badge kosong">Belum diisi</span>';
  if (String(item.stock) === '0') html += '<span class="badge stockzero">Tidak ada</span>';
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

  await onAreaChange();
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

function populateWeekSelect() {
  const [y, m] = el('monthSel').value.split('-').map(Number);
  currentWeeks = getWeeksForMonth(y, m);
  el('weekSel').innerHTML = currentWeeks
    .map((w, i) => `<option value="${i}">${w.label} (${fmtShort(w.start)} - ${fmtShort(w.end)})</option>`)
    .join('');
  let idx = findWeekContaining(currentWeeks, TODAY);
  if (idx === -1) idx = 0;
  el('weekSel').value = idx;
  currentWeek = currentWeeks[idx];
}

// ---------- Event wiring ----------

function attachStaticHandlers() {
  el('areaSel').addEventListener('change', onAreaChange);
  el('storeSel').addEventListener('change', onStoreChange);
  el('monthSel').addEventListener('change', onPeriodChange);
  el('weekSel').addEventListener('change', onPeriodChange);
  el('searchBox').addEventListener('input', (e) => { searchText = e.target.value; renderSkuList(); });

  el('tabInput').addEventListener('click', () => switchTab('input'));
  el('tabRecap').addEventListener('click', () => switchTab('recap'));
  el('tabStock').addEventListener('click', () => switchTab('stock'));

  el('modalReview').addEventListener('click', () => { hideModal(); switchTab('input'); });
  el('modalConfirm').addEventListener('click', onConfirmSubmit);

  el('stockAreaSel').addEventListener('change', refreshStockTab);
  el('stockFileInput').addEventListener('change', onStockFileSelected);
  el('stockSaveBtn').addEventListener('click', onStockSave);
}

async function onAreaChange() {
  populateStoreSelect(el('areaSel').value);
  await onStoreChange();
}

async function onStoreChange() {
  const storeId = el('storeSel').value;
  currentStore = stores.find(s => s.id === storeId);
  if (!currentStore) return;
  el('scopeInfo').textContent = `Scope channel: ${currentStore.scopeChannel} (${currentStore.subChannel})`;
  currentSkuList = await loadSkuList(currentStore.scopeSlug);
  populateWeekSelect();
  await loadEntryForCurrentPeriod();
  renderAll();
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
  el('viewInput').classList.toggle('hidden', tab !== 'input');
  el('viewRecap').classList.toggle('hidden', tab !== 'recap');
  el('viewStock').classList.toggle('hidden', tab !== 'stock');
  el('searchBox').style.display = tab === 'input' ? 'block' : 'none';
  el('flagFilterRow').style.display = tab === 'input' ? 'flex' : 'none';
  if (tab === 'recap') renderRecap();
  if (tab === 'stock') refreshStockTab();
}

// ---------- Firestore load/save for entries ----------

function entryDocId(store, week) {
  return `${store.id}__${week.periodKey}`;
}

async function loadEntryForCurrentPeriod() {
  currentEntryDocId = entryDocId(currentStore, currentWeek);
  const ref = doc(db, 'entries', currentEntryDocId);
  const snap = await getDoc(ref);
  const saved = snap.exists() ? (snap.data().items || {}) : {};
  currentEntry = {};
  for (const sku of currentSkuList) {
    currentEntry[sku.barcode] = { ...emptyEntryFor(sku.barcode), ...(saved[sku.barcode] || {}) };
  }
}

function scheduleSaveField(barcode) {
  clearTimeout(saveTimers[barcode]);
  saveTimers[barcode] = setTimeout(() => saveField(barcode), 600);
}

async function saveField(barcode) {
  const ref = doc(db, 'entries', currentEntryDocId);
  await setDoc(ref, {
    storeId: currentStore.id,
    storeName: currentStore.name,
    area: currentStore.area,
    scopeSlug: currentStore.scopeSlug,
    periodKey: currentWeek.periodKey,
    weekStart: currentWeek.start.toISOString(),
    weekEnd: currentWeek.end.toISOString(),
    items: { [barcode]: currentEntry[barcode] },
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function submitAllZeroFilled() {
  const itemsToSave = {};
  for (const sku of currentSkuList) {
    const item = currentEntry[sku.barcode];
    const filled = {};
    for (const f of FIELDS) filled[f] = item[f] === '' || item[f] === undefined ? 0 : item[f];
    currentEntry[sku.barcode] = filled;
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
    chip.addEventListener('click', () => { flagFilter = chip.dataset.flag; renderSkuList(); });
  });
}

function renderSkuList() {
  const q = searchText.toLowerCase();
  const distStock = distributorCache[currentStore.area];
  const filtered = currentSkuList.filter(sku => {
    if (flagFilter !== 'all' && sku.flag !== flagFilter) return false;
    if (q && !sku.name.toLowerCase().includes(q)) return false;
    return true;
  });

  el('skuList').innerHTML = filtered.map(sku => {
    const item = currentEntry[sku.barcode];
    const s = statusOf(item);
    const warning = s !== 'lengkap'
      ? '<div class="sku-warning">Kolom kosong akan tercatat 0 saat dikirim</div>' : '';
    let distHint = '';
    if (distStock && sku.pcode && distStock.items[sku.pcode]) {
      const d = distStock.items[sku.pcode];
      distHint = `<div class="sku-distributor">Stock distributor (${currentStore.area}): ${d.karton} karton, ${d.lusin} lusin, ${d.pcs} pcs</div>`;
    }
    return `
      <div class="sku-item">
        <p class="sku-name">${sku.name}</p>
        <p class="sku-code">${sku.barcode}${sku.pcode ? ' &middot; PC ' + sku.pcode : ''}</p>
        <div>${badgeHtml(sku, item)}</div>
        ${warning}
        ${distHint}
        <div class="field-grid" style="margin-top:6px;">
          ${FIELDS.map(f => `
            <div>
              <label class="field-label">${FIELD_LABELS[f]}</label>
              <input type="number" min="0" data-barcode="${sku.barcode}" data-field="${f}" value="${item[f]}" placeholder="-">
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('') || '<p class="upload-status">Tidak ada produk yang cocok.</p>';

  el('skuList').querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const barcode = inp.dataset.barcode;
      currentEntry[barcode][inp.dataset.field] = inp.value;
      scheduleSaveField(barcode);
      renderProgress();
      renderReminder();
      // update just this item's badge/warning inline without full re-render for smoother typing
      const container = inp.closest('.sku-item');
      const sku = currentSkuList.find(s => s.barcode === barcode);
      container.querySelector('div').outerHTML = badgeHtml(sku, currentEntry[barcode]);
    });
  });
}

function renderRecap() {
  const total = currentSkuList.length;
  const lengkap = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) === 'lengkap').length;
  const belum = total - lengkap;
  const tidakAda = currentSkuList.filter(sku => String(currentEntry[sku.barcode].stock) === '0').length;

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
    return n + FIELDS.filter(f => item[f] === '' || item[f] === undefined).length;
  }, 0);
  if (missing > 0) {
    el('modalBody').textContent = `${missing} dari ${total} SKU wajib untuk ${currentWeek.label} belum lengkap, dengan total ${emptyFields} kolom kosong. Kolom kosong akan otomatis tercatat 0 jika Anda kirim sekarang.`;
  } else {
    el('modalBody').textContent = `Semua SKU wajib untuk ${currentWeek.label} sudah lengkap. Data siap dikirim.`;
  }
  showModal();
}

async function onConfirmSubmit() {
  await submitAllZeroFilled();
  hideModal();
  renderAll();
  renderRecap();
}

function showModal() { el('modalBackdrop').classList.add('show'); }
function hideModal() { el('modalBackdrop').classList.remove('show'); }

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
  await saveDistributorStock(area, pendingStockParse.items, pendingStockParse.fileName);
  distributorCache[area] = { items: pendingStockParse.items, sourceFileName: pendingStockParse.fileName, uploadedAt: { toDate: () => new Date() } };
  el('stockSaveBtn').textContent = 'Simpan ke database';
  await refreshStockTab();
  renderSkuList();
}

init();
