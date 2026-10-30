import { db, doc, getDoc, setDoc, serverTimestamp, authReady } from './firebase-init.js';
import { setupStoreGate } from './store-gate.js?v=3';
import { pickAccount, storeIsAllowed, getCurrentMapping, switchAccount } from './store-filter.js?v=2';
import { loadStores, loadSkuList, groupStoresByArea, loadVersionsMeta, loadVersion, resolveListVersion, skuListForStore } from './store-data.js?v=2';
import { getWeeksForMonth, findWeekContaining, fmtShort, MONTHS_ID, addDays, isoDate } from './weeks.js';
import { loadDistributorStock, parseDistributorWorkbook, saveDistributorStock, formatReportDate, stockKeyOf, stockKey, distCodeOf, distNameOf, sameDistributor } from './stock-upload.js?v=4';
import { pushStockToMonitoring } from './monitoring-sync.js?v=1';
import { supportsNativeBarcodeDetector, startNativeScan, stopNativeScan, startFallbackScan, stopFallbackScan } from './barcode-scan.js';
import { parsePurchaseWorkbook } from './purchase-upload.js';
import { computeDtStock, dtCodesHtml, fmtTotal, hasDistributorData, esc } from './dt-stock.js?v=1';
import { wireOosModal, showOosModal } from './oos-modal.js?v=6';
import { loadPromoSku, loadPriceEntry, savePriceField, loadCompetitors, addCompetitor, updateCompetitor } from './harga-data.js';
import { FIELDS, EDITABLE_FIELDS, fieldTotal, fieldIsEmpty, normalizeField, statusOf, buildOosDetail } from './entry-utils.js?v=3';

const FIELD_LABELS = { stock: 'Stock', order: 'Order', masuk: 'Masuk', jual: 'Jual' };
const FLAG_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD' };
const FLAG_CLASS = { 'COTC': 'flag-cotc', 'MARKET MAKING': 'flag-market', 'NPD': 'flag-npd' };

const TODAY = new Date(); // tanggal perangkat SBA saat app dibuka

let stores = [];
let storesByArea = {};
let storeGate = null;
let supArea = ''; // area supervisor (mode Supervisor)
let supervisorMode = false; // masuk tanpa toko (tombol Supervisor di layar pilih toko)
// Filter channel (LMT SPM / Local Minis / Haba DT) untuk daftar Area & Toko. 'all' = tanpa filter.
const CHANNEL_ORDER = ['lmt-spm', 'local-minis', 'haba-dt'];
const CHANNEL_LABELS = { 'lmt-spm': 'LMT SPM', 'local-minis': 'Local Minis', 'haba-dt': 'Haba DT' };
const channelLabel = slug => CHANNEL_LABELS[slug] || slug;
let channelFilter = 'all';
function channelStores() { return channelFilter === 'all' ? stores : stores.filter(s => s.scopeSlug === channelFilter); }
function channelStoresByArea() { return groupStoresByArea(channelStores()); }
let currentStore = null;
let currentSkuList = [];
let currentListVersion = null; // id versi daftar toko/SKU yang dipakai entry minggu ini (dicatat di entry.listVersion)
let currentEntry = {}; // { [barcode]: {stock,order,masuk,jual} }
let currentEntryDocId = null;
let currentWeeks = [];
let currentWeek = null;
let flagFilter = 'all';
let searchText = '';
let skuSortOrder = 'asc';
let buFilter = 'all';
let categoryFilter = 'all';
let brandFilter = 'all';
let expandedSkuGroups = {};
// Filter + collapse khusus tab Rekap (terpisah dari filter tab Input)
let recapFlagFilter = 'all';
let recapSearch = '';
let recapSort = 'asc';
let recapBu = 'all';
let recapCategory = 'all';
let recapBrand = 'all';
let recapExpanded = {}; // kunci: 'oos' / 'belum' (section) atau 'oos|<BU>' / 'belum|<BU>' (grup BU)
let priceEligible = false; // sekarang selalu true (semua toko) setelah onStoreChange jalan
let currentPriceEntry = {}; // barcode -> {unileverPrice, competitorPrices:{id:price}} -- data harga bulan ini
let priceCompetitors = {}; // barcode -> {competitorId: {brand, productName, packSize}} -- master kompetitor global
let expandedPriceCompetitor = {}; // barcode -> bool, collapsed by default
let openPriceAddForm = null; // barcode yang sedang buka form "+ Tambah kompetitor"
let editingPriceCompetitor = null; // {barcode, competitorId} yang sedang diedit
let currentPriceMonthKey = null;
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
  if (s !== 'lengkap') {
    html += fieldIsEmpty(item.stock)
      ? '<div class="sku-warning">Stock belum diisi. Kalau memang kosong, ketuk &ldquo;Stok kosong&rdquo; supaya tercatat Tidak ada.</div>'
      : '<div class="sku-warning">Kolom kosong akan tercatat 0 saat dikirim</div>';
  }
  return html;
}

// ---------- Init ----------

async function init() {
  await authReady;
  const { mapping } = await pickAccount();
  const allStores = await loadStores();
  stores = allStores.filter(s => storeIsAllowed(s.id));
  storesByArea = groupStoresByArea(stores);

  const nameLabel = document.getElementById('loggedInAs');
  if (nameLabel) nameLabel.textContent = mapping ? (mapping.name + (mapping.isMaster ? ' (semua toko)' : '')) : 'Semua toko';
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', switchAccount);

  if (!stores.length) {
    document.querySelector('.app').innerHTML = '<div class="card" style="margin-top:40px;"><p>Akun ini belum ter-mapping ke toko mana pun. Hubungi admin.</p></div>';
    return;
  }

  populateChannelSelect();
  populateAreaSelect();
  populateMonthSelect();
  attachStaticHandlers();

  storeGate = setupStoreGate({ pageKey: 'input', stores, channelLabel, onPick: s => pickStoreFromSearch(s.id), onSupervisor: enterSupervisor });
  el('supPickBtn').addEventListener('click', () => storeGate.open());
  el('supMasukBtn').addEventListener('click', () => switchTab('masuk'));
  el('supStockBtn').addEventListener('click', () => switchTab('stock'));
  await applyUrlParamsAndLoad();
}

// Dashboard rekap lintas toko mengirim link seperti index.html?store=<id>&period=<YYYY-MM-DD>
// supaya supervisor bisa klik "Buka" dan langsung diarahkan ke toko + minggu yang tepat.
async function applyUrlParamsAndLoad() {
  const params = new URLSearchParams(window.location.search);
  const paramStore = params.get('store') ? stores.find(s => s.id === params.get('store')) : null;
  const paramPeriod = params.get('period');

  if (paramStore) {
    setChannelFilter('all');
    el('areaSel').value = paramStore.area;
    populateStoreSelect(paramStore.area);
    el('storeSel').value = paramStore.id;
  } else {
    populateStoreSelect(el('areaSel').value);
    // Tanpa link dashboard: pakai toko yang sudah dikonfirmasi di sesi ini (refresh), atau minta SBA memilih dulu.
    if (!(await storeGate.restore())) storeGate.open();
    return;
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
  if (currentStore) storeGate.remember(currentStore);
  if (paramStore) showToast(`Dibuka dari dashboard: ${paramStore.name}`, 'success');
}

function populateChannelSelect() {
  const slugs = [...new Set(stores.map(s => s.scopeSlug))].sort((a, b) => {
    const ia = CHANNEL_ORDER.indexOf(a), ib = CHANNEL_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const saved = localStorage.getItem('sba_channel_filter');
  channelFilter = (saved && slugs.includes(saved)) ? saved : 'all';
  el('channelSel').innerHTML = `<option value="all">Semua channel (${stores.length} toko)</option>`
    + slugs.map(sl => `<option value="${sl}">${channelLabel(sl)} (${stores.filter(s => s.scopeSlug === sl).length} toko)</option>`).join('');
  el('channelSel').value = channelFilter;
}

function setChannelFilter(value) {
  channelFilter = value;
  el('channelSel').value = value;
  if (value === 'all') localStorage.removeItem('sba_channel_filter');
  else localStorage.setItem('sba_channel_filter', value);
  populateAreaSelect(true);
}

function populateAreaSelect(keepCurrent) {
  const prev = keepCurrent ? el('areaSel').value : '';
  const areas = Object.keys(channelStoresByArea()).sort();
  el('areaSel').innerHTML = areas.map(a => `<option value="${a}">${a}</option>`).join('');
  if (prev && areas.includes(prev)) el('areaSel').value = prev;
}

function populateStoreSelect(area) {
  const list = channelStoresByArea()[area] || [];
  const tag = channelFilter === 'all';
  el('storeSel').innerHTML = list
    .map(s => `<option value="${s.id}">${s.name}${tag ? ' \u00b7 ' + channelLabel(s.scopeSlug) : ''}</option>`)
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
  el('channelSel').addEventListener('change', onChannelChange);
  el('areaSel').addEventListener('change', onAreaChange);
  el('storeSearch').addEventListener('input', renderStoreSearchResults);
  el('storeSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = el('storeSearchResults').querySelector('.store-search-item');
    if (first) { e.preventDefault(); pickStoreFromSearch(first.dataset.storeId); }
  });
  el('storeSel').addEventListener('change', () => onStoreChange());
  el('monthSel').addEventListener('change', onMonthChange);
  el('weekSel').addEventListener('change', onWeekChange);
  el('searchBox').addEventListener('input', (e) => { searchText = e.target.value; renderSkuList(); });
  el('sortToggleBtn').addEventListener('click', () => {
    skuSortOrder = skuSortOrder === 'asc' ? 'desc' : 'asc';
    el('sortToggleBtn').innerHTML = skuSortOrder === 'asc'
      ? 'A-Z <span id="sortIcon">&#8595;</span>'
      : 'Z-A <span id="sortIcon">&#8593;</span>';
    renderSkuList();
  });
  el('buFilterSel').addEventListener('change', (e) => { buFilter = e.target.value; renderSkuList(); });
  el('categoryFilterSel').addEventListener('change', (e) => { categoryFilter = e.target.value; renderSkuList(); });
  el('brandFilterSel').addEventListener('change', (e) => { brandFilter = e.target.value; renderSkuList(); });
  el('promoToggleBtn').addEventListener('click', () => {
    promoExpanded = !promoExpanded;
    el('promoBody').classList.toggle('expanded', promoExpanded);
    el('promoToggleIcon').classList.toggle('open', promoExpanded);
    if (promoExpanded) renderPromoSection();
  });
  el('promoSearchBox').addEventListener('input', (e) => { promoSearchText = e.target.value; renderPromoSection(); });

  el('tabInput').addEventListener('click', () => switchTab('input'));
  el('tabRecap').addEventListener('click', () => switchTab('recap'));
  el('tabStock').addEventListener('click', () => switchTab('stock'));
  el('tabMasuk').addEventListener('click', () => switchTab('masuk'));

  wireOosModal();
  el('modalReview').addEventListener('click', () => { hideModal(); switchTab('input'); });
  el('modalConfirm').addEventListener('click', onConfirmSubmit);

  el('stockTargetBox').addEventListener('click', onStockTargetClick);
  el('stockMatch').addEventListener('click', onStockMatchClick);
  el('stockConfirmYes').addEventListener('click', onStockConfirmYes);
  el('stockConfirmNo').addEventListener('click', () => el('stockConfirmBackdrop').classList.remove('show'));
  el('stockFileInput').addEventListener('change', onStockFileSelected);
  el('stockSaveBtn').addEventListener('click', onStockSave);
  el('masukBox').addEventListener('click', onMasukBoxClick);
  el('masukFileInput').addEventListener('change', onMasukFileSelected);
  el('masukSaveBtn').addEventListener('click', onMasukSave);

  el('scanBtn').addEventListener('click', openScanModal);
  el('scanCloseBtn').addEventListener('click', closeScanModal);
}

// Cari toko by nama di SEMUA area (bukan cuma dropdown). Pilih hasilnya = area + toko
// otomatis ikut berpindah.
function renderStoreSearchResults() {
  const q = el('storeSearch').value.trim().toLowerCase();
  const box = el('storeSearchResults');
  if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const matches = channelStores().filter(s => s.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const MAX = 30;
  box.innerHTML = matches.length
    ? matches.slice(0, MAX).map(s => `<button type="button" class="store-search-item" data-store-id="${esc(s.id)}"><span>${esc(s.name)}</span><small>${esc(s.area)} &middot; ${esc(channelLabel(s.scopeSlug))}</small></button>`).join('')
      + (matches.length > MAX ? `<div class="store-search-empty">+${matches.length - MAX} toko lain, persempit pencarian.</div>` : '')
    : '<div class="store-search-empty">Toko tidak ditemukan.</div>';
  box.style.display = 'block';
  box.querySelectorAll('.store-search-item').forEach(btn => {
    btn.addEventListener('click', () => pickStoreFromSearch(btn.dataset.storeId));
  });
}

async function pickStoreFromSearch(storeId) {
  const store = stores.find(s => s.id === storeId);
  if (!store) return;
  if (channelFilter !== 'all' && store.scopeSlug !== channelFilter) setChannelFilter('all');
  el('areaSel').value = store.area;
  populateStoreSelect(store.area);
  el('storeSel').value = store.id;
  el('storeSearch').value = '';
  renderStoreSearchResults();
  await onStoreChange();
}

async function onChannelChange() {
  setChannelFilter(el('channelSel').value);
  populateStoreSelect(el('areaSel').value);
  await onStoreChange();
}

async function onAreaChange() {
  populateStoreSelect(el('areaSel').value);
  await onStoreChange();
}

// Supervisor masuk tanpa toko: Input dan Rekap diganti kartu penjelasan, Stock dist. dan Upload Extract tetap jalan.
function enterSupervisor(area) {
  supervisorMode = true;
  supArea = area;
  stockTarget = null;
  const opt = stockOptions().find(a => a.area === area);
  if (opt && opt.dists.length === 1) setStockDist(opt, opt.dists[0]);
  else if (opt) stockTarget = { area, dist: null, key: '', count: 0 };
  resetStockFile();
  switchTab(currentTab === 'input' || currentTab === 'recap' ? 'masuk' : currentTab);
}

function applySupervisorView() {
  const blocked = supervisorMode && (currentTab === 'input' || currentTab === 'recap');
  el('supNote').hidden = !blocked;
  if (!blocked) return;
  el('viewInput').classList.add('hidden');
  el('viewRecap').classList.add('hidden');
  el('searchBox').style.display = 'none';
  el('flagFilterRow').style.display = 'none';
}

async function onStoreChange(preferPeriodKey) {
  const storeId = el('storeSel').value;
  currentStore = stores.find(s => s.id === storeId);
  if (!currentStore) return;
  const wasSupervisor = supervisorMode;
  supervisorMode = false;
  if (wasSupervisor) stockTarget = null; // tujuan stock tidak dibawa dari mode Supervisor
  el('scopeInfo').textContent = `Scope channel: ${currentStore.scopeChannel} (${currentStore.subChannel})`;
  currentSkuList = await loadSkuList(currentStore.scopeSlug);
  populateSkuFilterDropdowns();
  buFilter = 'all';
  categoryFilter = 'all';
  brandFilter = 'all';
  expandedSkuGroups = {};
  recapFlagFilter = 'all';
  recapSearch = '';
  recapBu = 'all';
  recapCategory = 'all';
  recapBrand = 'all';
  recapExpanded = {};
  // Harga jual (+ kompetitor) sekarang tersedia utk SEMUA toko (sebelumnya cuma
  // scope Survei Harga LMT SPM "EC BIG" + Beauty).
  priceEligible = true;
  expandedPriceCompetitor = {};
  if (priceEligible && !Object.keys(priceCompetitors).length) {
    priceCompetitors = await loadCompetitors();
  }
  populateWeekSelect(preferPeriodKey);
  await Promise.all([
    loadEntryForCurrentPeriod(),
    ensureDistributorStockLoaded(currentStore)
  ]);
  renderAll();
  if (wasSupervisor) switchTab('input'); // keluar dari mode Supervisor: buka Input toko yang dipilih
  else if (currentTab === 'stock') refreshStockTab();
  else if (currentTab === 'masuk') refreshMasukTab();
}

// Data stock distributor dimuat sekali per area lalu di-cache di memori.
// Dulu ini cuma dimuat kalau tab "Stock distributor" dibuka -- akibatnya
// SBA yang langsung ke tab Input tidak pernah melihat info stock distributor
// walau datanya sudah ada di database. Sekarang dimuat otomatis begitu toko dipilih.
async function ensureDistributorStockLoaded(store) {
  const key = stockKeyOf(store);
  if (distributorCache[key] !== undefined) return;
  try {
    distributorCache[key] = await loadDistributorStock(store.area, { code: distCodeOf(store), name: distNameOf(store) });
  } catch (err) {
    console.error('Gagal memuat stock distributor:', err);
    distributorCache[key] = null;
  }
}

async function onMonthChange() {
  populateWeekSelect();
  await afterPeriodDataChange();
}

async function onWeekChange() {
  // PENTING: jangan panggil populateWeekSelect() di sini. Fungsi itu membangun ulang
  // seluruh daftar <option> dan (kalau tidak dikasih preferPeriodKey) otomatis balik
  // ke minggu yang mengandung tanggal HARI INI -- efeknya pilihan manual user di
  // dropdown Minggu langsung ketimpa detik itu juga. Cukup baca index yang baru dipilih.
  const idx = Number(el('weekSel').value);
  if (currentWeeks[idx]) currentWeek = currentWeeks[idx];
  await afterPeriodDataChange();
}

async function afterPeriodDataChange() {
  await loadEntryForCurrentPeriod();
  renderAll();
  // Kalau sedang di tab Stock distributor / Barang Masuk, refresh juga -- dulu cuma
  // ke-refresh kalau pindah tab lalu balik lagi, jadi kelihatan seperti "Minggu tidak
  // bisa diganti" waktu masih di tab yang sama.
  if (currentTab === 'stock') refreshStockTab();
  if (currentTab === 'masuk') refreshMasukTab();
}

function switchTab(tab) {
  currentTab = tab;
  document.body.dataset.tab = tab;
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
  applySupervisorView();
}

// ---------- Firestore load/save for entries ----------

function entryDocId(store, week) {
  return `${store.id}__${week.periodKey}`;
}

let previousWeekItems = {};
let currentPromoList = []; // SKU Promo (bukan bagian SKU wajib) utk scope+bulan toko ini
let currentPromoEntry = {}; // pcode -> stock string, tersimpan terpisah dari SKU wajib
let promoExpanded = false;
let promoSearchText = '';

async function loadEntryForCurrentPeriod() {
  currentEntryDocId = entryDocId(currentStore, currentWeek);
  const ref = doc(db, 'entries', currentEntryDocId);
  const prevPeriodKey = isoDate(addDays(currentWeek.start, -7));
  const prevRef = doc(db, 'entries', `${currentStore.id}__${prevPeriodKey}`);
  const monthKey = `${currentWeek.start.getFullYear()}-${String(currentWeek.start.getMonth() + 1).padStart(2, '0')}`;
  currentPriceMonthKey = monthKey;
  let snap, prevSnap, promoDoc;
  try {
    [snap, prevSnap, promoDoc] = await Promise.all([
      getDoc(ref),
      getDoc(prevRef),
      loadPromoSku(currentStore.scopeSlug, monthKey)
    ]);
  } catch (err) {
    console.error('Gagal memuat data minggu ini/minggu lalu:', err);
    snap = null; prevSnap = null; promoDoc = null;
  }
  currentPriceEntry = priceEligible ? await loadPriceEntry(currentStore.id, monthKey).catch((err) => {
    console.error('Gagal memuat data harga bulan ini:', err);
    return {};
  }) : {};
  // Daftar SKU mengikuti versi entry (data yang sudah terisi tidak berubah saat daftar diperbarui),
  // atau versi yang berlaku untuk minggu ini kalau entry masih kosong. Lihat store-data.js.
  const savedDoc = snap && snap.exists() ? snap.data() : null;
  const versionsMeta = await loadVersionsMeta();
  currentListVersion = resolveListVersion(versionsMeta, savedDoc, currentWeek.periodKey);
  currentSkuList = skuListForStore(await loadVersion(currentListVersion), currentStore);
  populateSkuFilterDropdowns();
  const saved = snap && snap.exists() ? (snap.data().items || {}) : {};
  const savedPromo = snap && snap.exists() ? (snap.data().promoItems || {}) : {};
  previousWeekItems = prevSnap && prevSnap.exists() ? (prevSnap.data().items || {}) : {};
  currentEntry = {};
  for (const sku of currentSkuList) {
    const savedItem = saved[sku.barcode] || {};
    const entry = {};
    for (const f of FIELDS) entry[f] = normalizeField(savedItem[f]);
    currentEntry[sku.barcode] = entry;
  }

  // SKU Promo yang SUDAH termasuk SKU wajib tidak perlu ditampilkan dobel di section ini --
  // sudah muncul (dengan flag-nya) di daftar SKU wajib di atas.
  const wajibPcodes = new Set(currentSkuList.map(s => s.pcode).filter(Boolean));
  currentPromoList = (promoDoc && Array.isArray(promoDoc.items))
    ? promoDoc.items.filter(it => !wajibPcodes.has(it.pcode))
    : [];
  currentPromoEntry = {};
  for (const it of currentPromoList) {
    const raw = savedPromo[it.pcode];
    currentPromoEntry[it.pcode] = raw && raw.stock !== undefined ? String(raw.stock) : '';
  }
  // Collapse ulang tiap ganti toko/minggu supaya tidak otomatis kepanjangan ke bawah.
  promoExpanded = false;
  promoSearchText = '';
  if (el('promoBody')) el('promoBody').classList.remove('expanded');
  if (el('promoToggleIcon')) el('promoToggleIcon').classList.remove('open');
  if (el('promoSearchBox')) el('promoSearchBox').value = '';
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
      listVersion: currentListVersion,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('Gagal menyimpan field:', err);
    showToast('Gagal menyimpan perubahan. Cek koneksi internet.', 'danger');
  }
}

// Stock DT per barcode (pcs) pada saat rekap dikirim. hasData=false kalau laporan DT area ini belum di-upload.
function buildDtSnapshot(skuList, distStock) {
  if (!distStock || !hasDistributorData(distStock.items)) return { hasData: false };
  const pcs = {};
  for (const sku of skuList) pcs[sku.barcode] = computeDtStock(sku, distStock.items).dtQty;
  return {
    hasData: true,
    reportDate: distStock.reportDate || null,
    distributorName: distStock.distributorName || null,
    pcs
  };
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
  // distributorStock cuma menyimpan snapshot terbaru, jadi stock DT dicatat di entry saat dikirim
  // supaya export tetap menunjukkan kondisi DT pada waktu SBA mengirim rekap.
  await ensureDistributorStockLoaded(currentStore);
  const dtSnapshot = buildDtSnapshot(currentSkuList, distributorCache[stockKeyOf(currentStore)]);
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
    dtSnapshot,
    listVersion: currentListVersion,
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
  renderPromoSection();
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

function populateSkuFilterDropdowns() {
  const uniqueSorted = (key) => [...new Set(currentSkuList.map(s => s[key]).filter(Boolean))].sort();
  const buildOptions = (values, allLabel) =>
    `<option value="all">${allLabel}</option>` + values.map(v => `<option value="${v}">${v}</option>`).join('');
  el('buFilterSel').innerHTML = buildOptions(uniqueSorted('bu'), 'Semua BU');
  el('categoryFilterSel').innerHTML = buildOptions(uniqueSorted('category'), 'Semua Category');
  el('brandFilterSel').innerHTML = buildOptions(uniqueSorted('brand'), 'Semua Brand');
}

// Tombol sengaja-kosong: stock/order yang memang 0 dicatat 0 tanpa mengetik, jadi terbaca terisi di rekap
// (stock 0 = "Tidak ada"). Ketuk lagi untuk membatalkan.
const ZERO_LABEL = { stock: ['Stok kosong', 'Stok kosong \u2713'], order: ['Tidak order', 'Tidak order \u2713'] };
const isZeroField = (fo, isi) => !fieldIsEmpty(fo) && fieldTotal(fo, isi) === 0;
function zeroBtnHtml(sku, f, fo) {
  const on = isZeroField(fo, sku.isi);
  return `<button type="button" class="zero-btn${on ? ' on' : ''}" data-zero-barcode="${sku.barcode}" data-zero-field="${f}" aria-pressed="${on}">${ZERO_LABEL[f][on ? 1 : 0]}</button>`;
}

function skuCardHtml(sku, distStock) {
  const item = currentEntry[sku.barcode];
  // Stock DT = jumlah semua SKU Code dengan barcode yang sama; rincian per kode bisa dibuka.
  let distHint = '';
  if (distStock && hasDistributorData(distStock.items)) {
    const dt = computeDtStock(sku, distStock.items);
    distHint = `<div class="sku-distributor">Stock distributor (${currentStore.area}): ${dt.dtQty > 0 ? `${fmtTotal(dt.dtQty, sku.isi)} (= ${dt.dtQty} pcs)` : 'kosong'}</div>${dtCodesHtml(dt)}`;
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
                ${zeroBtnHtml(sku, f, fo)}
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
      ${priceEligible ? priceSectionHtml(sku) : ''}
    </div>
  `;
}

// Harga jual (+ kompetitor) -- cuma utk toko yang termasuk scope Survei Harga.
// Data harga ini SAMA dengan yang dipakai halaman Survei Harga (kunci barcode,
// per bulan) -- isi dari sini atau dari sana, hasilnya nyambung, tidak dobel kerja.
function priceSectionHtml(sku) {
  const barcode = sku.barcode;
  const priceItem = currentPriceEntry[barcode] || {};
  const unileverPrice = priceItem.unileverPrice ?? '';
  const compList = priceCompetitors[barcode] || {};
  const compIds = Object.keys(compList);
  const isOpen = !!expandedPriceCompetitor[barcode];
  const filledCompCount = compIds.filter(cid => {
    const p = (priceItem.competitorPrices || {})[cid];
    return p !== undefined && p !== '' && p !== null;
  }).length;

  const compHtml = compIds.map(cid => {
    const c = compList[cid];
    const price = (priceItem.competitorPrices || {})[cid] ?? '';
    const isEditing = editingPriceCompetitor && editingPriceCompetitor.barcode === barcode && editingPriceCompetitor.competitorId === cid;
    if (isEditing) {
      return `
        <div class="competitor-item">
          <div class="competitor-form" data-price-edit-form-for="${barcode}" data-price-edit-competitor-id="${cid}">
            <label class="field-label">Brand kompetitor</label>
            <input type="text" class="price-comp-brand" value="${c.brand || ''}">
            <label class="field-label">Nama produk</label>
            <input type="text" class="price-comp-name" value="${c.productName || ''}">
            <label class="field-label">Ukuran kemasan (opsional)</label>
            <input type="text" class="price-comp-size" value="${c.packSize || ''}">
            <div style="display:flex; gap:6px;">
              <button type="button" class="price-comp-edit-cancel" style="flex:1;">Batal</button>
              <button type="button" class="price-comp-edit-save primary" style="flex:1;">Simpan koreksi</button>
            </div>
          </div>
        </div>
      `;
    }
    return `
      <div class="competitor-item">
        <div class="competitor-name-row">
          <p class="competitor-name">${c.brand} - ${c.productName}${c.packSize ? ' (' + c.packSize + ')' : ''}</p>
          <button type="button" class="price-competitor-edit-btn" data-price-edit-barcode="${barcode}" data-price-edit-cid="${cid}">Edit</button>
        </div>
        <div class="price-input-wrap">
          <span>Rp</span>
          <input type="number" min="0" data-price-barcode="${barcode}" data-price-kind="competitor" data-price-competitor-id="${cid}" value="${price}" placeholder="Harga di toko ini">
        </div>
      </div>
    `;
  }).join('');

  const formOpen = openPriceAddForm === barcode;

  return `
    <div class="price-row" style="margin-top:10px;">
      <div class="price-row-head"><label class="field-label">Harga jual di toko (Rp)</label></div>
      <div class="price-input-wrap">
        <span>Rp</span>
        <input type="number" min="0" data-price-barcode="${barcode}" data-price-kind="unilever" value="${unileverPrice}" placeholder="Harga jual">
      </div>
    </div>
    <button type="button" class="promo-toggle price-competitor-toggle" data-price-toggle="${barcode}" style="margin-top:8px;">
      <span>Harga kompetitor${filledCompCount ? ` (${filledCompCount}/${compIds.length} terisi)` : compIds.length ? ` (0/${compIds.length} terisi)` : ' (belum ada kompetitor)'}</span>
      <span class="product-group-icon ${isOpen ? 'open' : ''}">&#9656;</span>
    </button>
    <div class="product-group-body" data-price-competitor-body="${barcode}" style="display:${isOpen ? 'block' : 'none'}; margin-top:8px;">
      ${compHtml}
      ${!compIds.length && !formOpen ? '<p class="upload-status">Belum ada kompetitor untuk produk ini. Klik "+ Tambah kompetitor", isi brand/produknya sekaligus harga di toko ini.</p>' : ''}
      ${formOpen ? `
        <div class="competitor-form" data-price-form-for="${barcode}">
          <label class="field-label">Brand kompetitor</label>
          <input type="text" class="price-comp-brand" placeholder="Misal: Wardah, Formula, Daia">
          <label class="field-label">Nama produk</label>
          <input type="text" class="price-comp-name" placeholder="Nama produk kompetitor">
          <label class="field-label">Ukuran kemasan (opsional)</label>
          <input type="text" class="price-comp-size" placeholder="Misal: 190g">
          <label class="field-label">Harga di toko ini (Rp)</label>
          <div class="price-input-wrap" style="margin-bottom:8px;">
            <span>Rp</span>
            <input type="number" min="0" class="price-comp-price" placeholder="Harga kompetitor di toko ini">
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="price-comp-cancel" style="flex:1;">Batal</button>
            <button type="button" class="price-comp-save primary" style="flex:1;">Simpan kompetitor</button>
          </div>
        </div>
      ` : `<button type="button" class="add-competitor-btn" data-price-open-for="${barcode}">+ Tambah kompetitor</button>`}
    </div>
  `;
}

function skuGroupRecap(list) {
  const total = list.length;
  const lengkap = list.filter(sku => statusOf(currentEntry[sku.barcode]) === 'lengkap').length;
  const tidakAda = list.filter(sku => {
    const stockField = currentEntry[sku.barcode].stock;
    return !fieldIsEmpty(stockField) && fieldTotal(stockField, sku.isi) === 0;
  }).length;
  return { total, lengkap, tidakAda };
}

function renderSkuList() {
  const q = searchText.toLowerCase();
  const distStock = distributorCache[stockKeyOf(currentStore)];
  let filtered = currentSkuList.filter(sku => {
    if (flagFilter !== 'all' && sku.flag !== flagFilter) return false;
    if (buFilter !== 'all' && sku.bu !== buFilter) return false;
    if (categoryFilter !== 'all' && sku.category !== categoryFilter) return false;
    if (brandFilter !== 'all' && sku.brand !== brandFilter) return false;
    if (q && !sku.name.toLowerCase().includes(q) && !sku.barcode.includes(q)) return false;
    return true;
  });
  filtered = filtered.sort((a, b) => skuSortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));

  if (!filtered.length) {
    el('skuList').innerHTML = '<p class="upload-status">Tidak ada produk yang cocok.</p>';
    return;
  }

  // Dikelompokkan per BU, collapsible, dengan ringkasan (lengkap/tidak ada) di tiap
  // header grup -- supaya daftar SKU wajib yang panjang lebih rapi dan tidak perlu
  // scroll semuanya cuma untuk lihat progress per kelompok.
  const groups = {};
  const groupOrderSeen = [];
  for (const sku of filtered) {
    const g = sku.bu || 'Lainnya';
    if (!groups[g]) { groups[g] = []; groupOrderSeen.push(g); }
    groups[g].push(sku);
  }
  groupOrderSeen.sort();

  el('skuList').innerHTML = groupOrderSeen.map(g => {
    const list = groups[g];
    const recap = skuGroupRecap(list);
    const isOpen = !!expandedSkuGroups[g];
    return `
      <div class="product-group">
        <button type="button" class="promo-toggle sku-group-toggle" data-group="${g}">
          <span>${g} &middot; ${recap.lengkap}/${recap.total} lengkap${recap.tidakAda ? ` &middot; ${recap.tidakAda} tidak ada` : ''}</span>
          <span class="product-group-icon ${isOpen ? 'open' : ''}">&#9656;</span>
        </button>
        <div class="product-group-body" data-sku-group-body="${g}" style="display:${isOpen ? 'block' : 'none'}; margin-top:8px;">
          ${isOpen ? list.map(sku => skuCardHtml(sku, distStock)).join('') : ''}
        </div>
      </div>
    `;
  }).join('');

  el('skuList').querySelectorAll('.sku-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.group;
      expandedSkuGroups[g] = !expandedSkuGroups[g];
      renderSkuList();
    });
  });

  const afterFieldChange = (container, barcode, field) => {
    scheduleSaveField(barcode);
    renderProgress();
    renderReminder();
    const sku = currentSkuList.find(s => s.barcode === barcode);
    container.querySelector('.sku-badges').innerHTML = badgeHtml(sku, currentEntry[barcode]);
    const totalEl = container.querySelector(`[data-total-for="${field}"]`);
    if (totalEl) totalEl.textContent = `= ${fieldTotal(currentEntry[barcode][field], sku.isi)} pcs`;
    const zb = container.querySelector(`[data-zero-field="${field}"]`);
    if (zb) {
      const on = isZeroField(currentEntry[barcode][field], sku.isi);
      zb.classList.toggle('on', on);
      zb.setAttribute('aria-pressed', on);
      zb.textContent = ZERO_LABEL[field][on ? 1 : 0];
    }
    if (field === 'stock') {
      const refEl = container.querySelector(`[data-order-ref-for="${barcode}"]`);
      if (refEl) refEl.innerHTML = orderRefHtml(sku, currentEntry[barcode]);
    }
  };

  el('skuList').querySelectorAll('.field-subinputs input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const { barcode, field, sub } = inp.dataset;
      currentEntry[barcode][field][sub] = inp.value;
      afterFieldChange(inp.closest('.sku-item'), barcode, field);
    });
  });

  el('skuList').querySelectorAll('.zero-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { zeroBarcode: barcode, zeroField: field } = btn.dataset;
      const sku = currentSkuList.find(s => s.barcode === barcode);
      const fo = currentEntry[barcode][field];
      const clear = isZeroField(fo, sku.isi);
      fo.karton = ''; fo.lusin = ''; fo.pcs = clear ? '' : '0';
      const container = btn.closest('.sku-item');
      for (const sub of ['karton', 'lusin', 'pcs']) {
        const inp = container.querySelector(`input[data-field="${field}"][data-sub="${sub}"]`);
        if (inp) inp.value = fo[sub];
      }
      afterFieldChange(container, barcode, field);
    });
  });

  if (priceEligible) wirePriceSectionEvents();
}

function wirePriceSectionEvents() {
  el('skuList').querySelectorAll('input[data-price-barcode]').forEach(inp => {
    inp.addEventListener('input', () => {
      const barcode = inp.dataset.priceBarcode;
      const kind = inp.dataset.priceKind;
      if (!currentPriceEntry[barcode]) currentPriceEntry[barcode] = {};
      if (kind === 'unilever') {
        currentPriceEntry[barcode].unileverPrice = inp.value;
        scheduleSavePriceField(barcode, 'unilever', null, inp.value);
      } else {
        const cid = inp.dataset.priceCompetitorId;
        if (!currentPriceEntry[barcode].competitorPrices) currentPriceEntry[barcode].competitorPrices = {};
        currentPriceEntry[barcode].competitorPrices[cid] = inp.value;
        scheduleSavePriceField(barcode, 'competitor', cid, inp.value);
      }
    });
  });

  el('skuList').querySelectorAll('.price-competitor-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const barcode = btn.dataset.priceToggle;
      expandedPriceCompetitor[barcode] = !expandedPriceCompetitor[barcode];
      renderSkuList();
    });
  });

  el('skuList').querySelectorAll('[data-price-open-for]').forEach(btn => {
    btn.addEventListener('click', () => { openPriceAddForm = btn.dataset.priceOpenFor; renderSkuList(); });
  });
  el('skuList').querySelectorAll('.price-comp-cancel').forEach(btn => {
    btn.addEventListener('click', () => { openPriceAddForm = null; renderSkuList(); });
  });
  el('skuList').querySelectorAll('.price-comp-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.competitor-form');
      const barcode = form.dataset.priceFormFor;
      const brand = form.querySelector('.price-comp-brand').value.trim();
      const productName = form.querySelector('.price-comp-name').value.trim();
      const packSize = form.querySelector('.price-comp-size').value.trim();
      const price = form.querySelector('.price-comp-price').value.trim();
      if (!brand || !productName) {
        showToast('Isi minimal brand dan nama produk kompetitor.', 'danger');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';
      try {
        const cid = await addCompetitor(barcode, { brand, productName, packSize });
        if (!priceCompetitors[barcode]) priceCompetitors[barcode] = {};
        priceCompetitors[barcode][cid] = { brand, productName, packSize };
        openPriceAddForm = null;
        // Harga (kalau diisi) langsung disimpan untuk toko + bulan ini, tanpa harus ketik ulang di kolom harga.
        let priceSaved = true;
        if (price !== '') {
          if (!currentPriceEntry[barcode]) currentPriceEntry[barcode] = {};
          if (!currentPriceEntry[barcode].competitorPrices) currentPriceEntry[barcode].competitorPrices = {};
          currentPriceEntry[barcode].competitorPrices[cid] = price;
          try {
            await savePriceField(currentStore, currentPriceMonthKey, barcode, 'competitor', cid, price);
          } catch (err) {
            priceSaved = false;
            console.error('Kompetitor tersimpan, tapi harga gagal disimpan:', err);
          }
        }
        if (priceSaved) showToast(`Kompetitor "${brand}" ditambahkan.`, 'success');
        else showToast(`Kompetitor "${brand}" ditambahkan, tapi harganya gagal disimpan. Isi lagi di kolom harga.`, 'danger');
        renderSkuList();
      } catch (err) {
        console.error('Gagal menambah kompetitor:', err);
        showToast(`Gagal menyimpan (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
        btn.disabled = false;
        btn.textContent = 'Simpan kompetitor';
      }
    });
  });

  el('skuList').querySelectorAll('.price-competitor-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editingPriceCompetitor = { barcode: btn.dataset.priceEditBarcode, competitorId: btn.dataset.priceEditCid };
      renderSkuList();
    });
  });
  el('skuList').querySelectorAll('.price-comp-edit-cancel').forEach(btn => {
    btn.addEventListener('click', () => { editingPriceCompetitor = null; renderSkuList(); });
  });
  el('skuList').querySelectorAll('.price-comp-edit-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.competitor-form');
      const barcode = form.dataset.priceEditFormFor;
      const cid = form.dataset.priceEditCompetitorId;
      const brand = form.querySelector('.price-comp-brand').value.trim();
      const productName = form.querySelector('.price-comp-name').value.trim();
      const packSize = form.querySelector('.price-comp-size').value.trim();
      if (!brand || !productName) {
        showToast('Isi minimal brand dan nama produk kompetitor.', 'danger');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Menyimpan...';
      try {
        await updateCompetitor(barcode, cid, { brand, productName, packSize });
        priceCompetitors[barcode][cid] = { ...priceCompetitors[barcode][cid], brand, productName, packSize };
        editingPriceCompetitor = null;
        showToast(`Data kompetitor "${brand}" dikoreksi.`, 'success');
        renderSkuList();
      } catch (err) {
        console.error('Gagal mengoreksi kompetitor:', err);
        showToast(`Gagal menyimpan (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
        btn.disabled = false;
        btn.textContent = 'Simpan koreksi';
      }
    });
  });
}

function scheduleSavePriceField(barcode, kind, competitorId, value) {
  const key = `price_${barcode}__${kind}__${competitorId || ''}`;
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(async () => {
    try {
      await savePriceField(currentStore, currentPriceMonthKey, barcode, kind, competitorId, value);
    } catch (err) {
      console.error('Gagal menyimpan harga:', err);
      showToast(`Gagal menyimpan harga (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
    }
  }, 600);
}

// SKU Promo: opsional, TIDAK dihitung ke progress/lengkap SKU wajib sama sekali.
// Cuma 1 kolom Stock sederhana (bukan karton/lusin/pcs) -- ini murni cek availability,
// bukan pencatatan operasional selengkap SKU wajib.
function promoBadgeHtml(val) {
  const isAda = val !== '' && Number(val) > 0;
  const isTidakAda = val !== '' && Number(val) === 0;
  if (isAda) return '<span class="badge lengkap">Ada</span>';
  if (isTidakAda) return '<span class="badge stockzero">Tidak ada</span>';
  return '<span class="badge kosong">Belum dicek</span>';
}

function renderPromoSection() {
  if (!currentPromoList.length) {
    el('promoSection').style.display = 'none';
    return;
  }
  el('promoSection').style.display = 'block';

  const filledCount = currentPromoList.filter(p => currentPromoEntry[p.pcode] !== '' && currentPromoEntry[p.pcode] !== undefined).length;
  el('promoToggleLabel').textContent = `SKU Promo (opsional) - ${filledCount}/${currentPromoList.length} dicek`;

  // Konten (pencarian + daftar) cuma dirender kalau section-nya sedang dibuka --
  // supaya daftar SKU wajib di atas tidak "kepanjangan" ke bawah begitu toko dibuka.
  if (!promoExpanded) return;

  const q = promoSearchText.trim().toLowerCase();
  const filtered = currentPromoList.filter(p =>
    !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.pcode || '').includes(q)
  );

  const distStock = distributorCache[stockKeyOf(currentStore)];
  el('promoList').innerHTML = filtered.map(p => {
    const val = currentPromoEntry[p.pcode] || '';
    let distHint = '';
    if (distStock && p.pcode && distStock.items[p.pcode]) {
      const d = distStock.items[p.pcode];
      distHint = `<div class="sku-distributor">Stock distributor (${currentStore.area}): ${d.karton} karton, ${d.lusin} lusin, ${d.pcs} pcs</div>`;
    }
    return `
      <div class="sku-item">
        <p class="sku-name">${p.name}</p>
        <p class="sku-code">${p.barcode || ''}${p.pcode ? ' &middot; PC ' + p.pcode : ''}</p>
        <div class="promo-badge" data-badge-for="${p.pcode}">${promoBadgeHtml(val)}</div>
        ${p.rsp ? `<p class="upload-status">RSP: Rp${Number(p.rsp).toLocaleString('id-ID')}</p>` : ''}
        ${distHint}
        <div style="margin-top:6px;">
          <label class="field-label">Stock (pcs)</label>
          <input type="number" min="0" data-promo-pcode="${p.pcode}" value="${val}" placeholder="-" style="max-width:120px;">
        </div>
      </div>
    `;
  }).join('') || '<p class="upload-status">Tidak ada SKU Promo yang cocok.</p>';

  el('promoList').querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('input', () => {
      const pcode = inp.dataset.promoPcode;
      currentPromoEntry[pcode] = inp.value;
      clearTimeout(saveTimers['promo_' + pcode]);
      saveTimers['promo_' + pcode] = setTimeout(() => savePromoStock(pcode, inp.value), 600);
      const badgeEl = el('promoList').querySelector(`.promo-badge[data-badge-for="${pcode}"]`);
      if (badgeEl) badgeEl.innerHTML = promoBadgeHtml(inp.value);
      el('promoToggleLabel').textContent = `SKU Promo (opsional) - ${currentPromoList.filter(p => currentPromoEntry[p.pcode] !== '' && currentPromoEntry[p.pcode] !== undefined).length}/${currentPromoList.length} dicek`;
    });
  });
}

async function savePromoStock(pcode, value) {
  const ref = doc(db, 'entries', currentEntryDocId);
  try {
    await setDoc(ref, {
      storeId: currentStore.id,
      periodKey: currentWeek.periodKey,
      promoItems: { [pcode]: { stock: value === '' ? '' : Number(value) } },
      listVersion: currentListVersion,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.error('Gagal menyimpan stock SKU Promo:', err);
    showToast('Gagal menyimpan stock SKU Promo. Cek koneksi internet.', 'danger');
  }
}

const isStockZero = (sku) => {
  const stockField = currentEntry[sku.barcode].stock;
  return !fieldIsEmpty(stockField) && fieldTotal(stockField, sku.isi) === 0;
};

function recapSelectHtml(id, key, allLabel, current) {
  const values = [...new Set(currentSkuList.map(s => s[key]).filter(Boolean))].sort();
  return `<select id="${id}"><option value="all">${allLabel}</option>`
    + values.map(v => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('')
    + '</select>';
}

// Tab Rekap: tombol kirim di atas (tidak perlu scroll ke bawah), daftar SKU dilipat per
// section lalu per BU, dengan pencarian + filter yang sama seperti tab Input.
function renderRecap() {
  const total = currentSkuList.length;
  const lengkap = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) === 'lengkap').length;
  const belum = total - lengkap;
  const tidakAda = currentSkuList.filter(isStockZero).length;

  el('viewRecap').innerHTML = `
    <div class="metric-grid">
      <div class="metric-card"><div class="label">Total SKU wajib</div><div class="value">${total}</div></div>
      <div class="metric-card"><div class="label">Lengkap</div><div class="value">${lengkap}</div></div>
      <div class="metric-card"><div class="label">Belum lengkap</div><div class="value">${belum}</div></div>
      <div class="metric-card${tidakAda ? ' metric-card-action' : ''}" id="recapOosCard"${tidakAda ? ' role="button" tabindex="0"' : ''}>
        <div class="label">Tidak ada di toko</div>
        <div class="value">${tidakAda}</div>
        ${tidakAda ? '<div class="metric-hint">Ketuk untuk detail &amp; kirim WA</div>' : ''}
      </div>
    </div>
    <button id="submitBtn" class="primary" style="width:100%; margin-bottom:12px;">Konfirmasi dan kirim</button>
    <div class="search-row">
      <input id="recapSearchBox" type="text" placeholder="Cari nama produk atau barcode" value="${esc(recapSearch)}">
    </div>
    <div class="chip-row" id="recapFlagRow"></div>
    <div class="sku-filter-row">
      ${recapSelectHtml('recapBuSel', 'bu', 'Semua BU', recapBu)}
      ${recapSelectHtml('recapCategorySel', 'category', 'Semua Category', recapCategory)}
      ${recapSelectHtml('recapBrandSel', 'brand', 'Semua Brand', recapBrand)}
      <button type="button" id="recapSortBtn" title="Urutkan nama produk">${recapSort === 'asc' ? 'A-Z <span>&#8595;</span>' : 'Z-A <span>&#8593;</span>'}</button>
    </div>
    <div id="recapLists"></div>
  `;

  el('submitBtn').addEventListener('click', onSubmitClick);
  el('recapSearchBox').addEventListener('input', (e) => { recapSearch = e.target.value; renderRecapLists(); });
  el('recapBuSel').addEventListener('change', (e) => { recapBu = e.target.value; renderRecapLists(); });
  el('recapCategorySel').addEventListener('change', (e) => { recapCategory = e.target.value; renderRecapLists(); });
  el('recapBrandSel').addEventListener('change', (e) => { recapBrand = e.target.value; renderRecapLists(); });
  el('recapSortBtn').addEventListener('click', () => {
    recapSort = recapSort === 'asc' ? 'desc' : 'asc';
    el('recapSortBtn').innerHTML = recapSort === 'asc' ? 'A-Z <span>&#8595;</span>' : 'Z-A <span>&#8593;</span>';
    renderRecapLists();
  });
  if (tidakAda) {
    const card = el('recapOosCard');
    card.addEventListener('click', openRecapOosModal);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRecapOosModal(); }
    });
  }
  renderRecapFlagChips();
  renderRecapLists();
}

// Popup yang sama dengan dashboard: stock DT per SKU + tombol bagikan ke WhatsApp.
async function openRecapOosModal() {
  await ensureDistributorStockLoaded(currentStore);
  const dist = distributorCache[stockKeyOf(currentStore)];
  const oosDetail = buildOosDetail(currentEntry, currentSkuList, (dist && dist.items) || {});
  showOosModal({ store: currentStore, week: currentWeek, oosDetail, dtAsOf: formatReportDate(dist && dist.reportDate) });
}

function renderRecapFlagChips() {
  const flags = ['all', 'COTC', 'MARKET MAKING', 'NPD'];
  el('recapFlagRow').innerHTML = flags.map(f => {
    const label = f === 'all' ? 'Semua' : (FLAG_LABELS[f] || f);
    return `<span class="chip ${recapFlagFilter === f ? 'active' : ''}" data-flag="${f}">${label}</span>`;
  }).join('');
  el('recapFlagRow').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      recapFlagFilter = chip.dataset.flag;
      renderRecapFlagChips();
      renderRecapLists();
    });
  });
}

function recapFilterList(list) {
  const q = recapSearch.trim().toLowerCase();
  return list
    .filter(sku => {
      if (recapFlagFilter !== 'all' && sku.flag !== recapFlagFilter) return false;
      if (recapBu !== 'all' && sku.bu !== recapBu) return false;
      if (recapCategory !== 'all' && sku.category !== recapCategory) return false;
      if (recapBrand !== 'all' && sku.brand !== recapBrand) return false;
      if (q && !sku.name.toLowerCase().includes(q) && !sku.barcode.includes(q)) return false;
      return true;
    })
    .sort((a, b) => recapSort === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
}

function recapSkuItemHtml(sku, withCode) {
  return `
    <div class="sku-item recap-jump" data-jump-barcode="${sku.barcode}">
      <p class="sku-name">${sku.name}</p>
      ${withCode ? `<p class="sku-code">${sku.barcode}${sku.pcode ? ' &middot; PC ' + sku.pcode : ''}</p>` : ''}
      <div>${badgeHtml(sku, currentEntry[sku.barcode])}</div>
    </div>`;
}

function recapToggleHtml(key, label, count, isOpen) {
  return `
    <button type="button" class="promo-toggle recap-toggle" data-recap-key="${esc(key)}">
      <span>${label} &middot; ${count}</span>
      <span class="product-group-icon ${isOpen ? 'open' : ''}">&#9656;</span>
    </button>`;
}

// Satu section (mis. "SKU tidak ada di toko"): dilipat, dan isinya dikelompokkan per BU (juga dilipat).
function recapSectionHtml(key, title, list, withCode) {
  if (!list.length) return '';
  const isOpen = !!recapExpanded[key];
  let body = '';
  if (isOpen) {
    const groups = {};
    for (const sku of list) {
      const g = sku.bu || 'Lainnya';
      if (!groups[g]) groups[g] = [];
      groups[g].push(sku);
    }
    body = Object.keys(groups).sort().map(g => {
      const gKey = `${key}|${g}`;
      const gOpen = !!recapExpanded[gKey];
      return `
        <div class="product-group">
          ${recapToggleHtml(gKey, esc(g), groups[g].length, gOpen)}
          <div class="product-group-body" style="display:${gOpen ? 'block' : 'none'}; margin-top:8px;">
            ${gOpen ? groups[g].map(sku => recapSkuItemHtml(sku, withCode)).join('') : ''}
          </div>
        </div>`;
    }).join('');
  }
  return `
    <div class="product-group">
      ${recapToggleHtml(key, title, list.length, isOpen)}
      <div class="product-group-body" style="display:${isOpen ? 'block' : 'none'}; margin-top:8px;">${body}</div>
    </div>`;
}

function renderRecapLists() {
  const tidakAdaAll = currentSkuList.filter(isStockZero);
  const belumAll = currentSkuList.filter(sku => statusOf(currentEntry[sku.barcode]) !== 'lengkap');
  const oos = recapFilterList(tidakAdaAll);
  const belum = recapFilterList(belumAll);

  let html = recapSectionHtml('oos', 'SKU tidak ada di toko (perlu restock)', oos, true)
    + recapSectionHtml('belum', 'Belum lengkap diisi', belum, false);
  if (!html) {
    html = (tidakAdaAll.length || belumAll.length)
      ? '<p class="upload-status">Tidak ada produk yang cocok.</p>'
      : '<p class="upload-status">Semua SKU sudah lengkap dan tersedia di toko.</p>';
  }
  el('recapLists').innerHTML = html;

  el('recapLists').querySelectorAll('.recap-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.recapKey;
      recapExpanded[k] = !recapExpanded[k];
      renderRecapLists();
    });
  });
  el('recapLists').querySelectorAll('.recap-jump').forEach(elm => {
    elm.addEventListener('click', () => jumpToSku(elm.dataset.jumpBarcode));
  });
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
    el('modalBody').textContent = `Toko: ${currentStore.name} (${currentStore.area}). ${missing} dari ${total} SKU wajib untuk ${currentWeek.label} belum lengkap, dengan total ${emptyFields} kolom kosong. Kolom kosong akan otomatis tercatat 0 jika Anda kirim sekarang. Untuk stock yang memang habis, ketuk "Stok kosong" di SKU-nya supaya tercatat sengaja.`;
  } else {
    el('modalBody').textContent = `Toko: ${currentStore.name} (${currentStore.area}). Semua SKU wajib untuk ${currentWeek.label} sudah lengkap. Data siap dikirim.`;
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

function jumpToSku(barcode, toastMessage) {
  const sku = currentSkuList.find(s => s.barcode === barcode);
  if (!sku) return;
  switchTab('input');
  flagFilter = 'all';
  buFilter = 'all';
  categoryFilter = 'all';
  brandFilter = 'all';
  searchText = barcode;
  el('searchBox').value = barcode;
  el('buFilterSel').value = 'all';
  el('categoryFilterSel').value = 'all';
  el('brandFilterSel').value = 'all';
  expandedSkuGroups[sku.bu || 'Lainnya'] = true;
  renderFlagFilterChips();
  renderSkuList();
  const card = document.querySelector(`.sku-item[data-barcode="${barcode}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash-highlight');
    setTimeout(() => card.classList.remove('flash-highlight'), 1600);
  }
  if (toastMessage) showToast(toastMessage, 'success');
}

function onBarcodeDetected(rawValue) {
  closeScanModal();
  const barcode = String(rawValue).trim();
  const sku = currentSkuList.find(s => s.barcode === barcode);
  if (!sku) {
    showToast(`Barcode ${barcode} tidak ada di SKU wajib toko ini.`, 'danger');
    return;
  }
  jumpToSku(barcode, `Ditemukan: ${sku.name}`);
}

// ---------- Hitung otomatis Penjualan ----------
// Rumus: Jual minggu N = Stock minggu N + Barang Masuk minggu N - Stock minggu N+1.
// Baru bisa dihitung setelah Stock minggu N+1 (minggu depannya) sudah diisi.
// Dipanggil dari 2 arah: (1) setelah SBA submit stock minggu ini -> hitung ulang
// Jual minggu SEBELUMNYA, dan (2) setelah Supervisor upload Barang Masuk untuk
// suatu minggu -> hitung ulang Jual minggu itu (kalau stock minggu depannya sudah ada).
// Versi daftar SKU untuk toko pada minggu tertentu: ikut entry yang sudah ada, atau versi yang berlaku bila masih kosong.
async function listVersionForStoreWeek(store, periodKey) {
  let entry = null;
  try {
    const snap = await getDoc(doc(db, 'entries', `${store.id}__${periodKey}`));
    entry = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error('Gagal membaca entry untuk menentukan versi daftar SKU:', err);
  }
  return resolveListVersion(await loadVersionsMeta(), entry, periodKey);
}

async function skuListForStoreWeek(store, periodKey) {
  return skuListForStore(await loadVersion(await listVersionForStoreWeek(store, periodKey)), store);
}

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
let stockTarget = null;      // {area, dist:{code,name}|null, key, count} -- harus dipilih SBA/supervisor sendiri, tanpa nilai awal
let stockAckMismatch = false;

// Pilihan tujuan unggah: Area -> Distributor, dari data toko (tiap toko tahu distributornya).
// Satu area bisa dilayani lebih dari satu distributor; toko tanpa data distributor dikelompokkan "Belum terdata".
function stockOptions() {
  const areas = {};
  for (const st of stores) {
    const a = areas[st.area] = areas[st.area] || { area: st.area, count: 0, dists: {} };
    a.count++;
    const code = distCodeOf(st);
    const d = a.dists[code] = a.dists[code] || { code, name: code ? distNameOf(st) : 'Belum terdata distributornya', count: 0 };
    d.count++;
  }
  return Object.values(areas).sort((x, y) => x.area.localeCompare(y.area, 'id'))
    .map(a => ({ ...a, dists: Object.values(a.dists).sort((x, y) => y.count - x.count) }));
}

function renderStockTarget() {
  const opts = stockOptions().filter(a => !supervisorMode || a.area === supArea);
  const cur = stockTarget;
  el('stockAreaGrid').innerHTML = opts.map(a =>
    `<button type="button" class="area-card${cur && cur.area === a.area ? ' selected' : ''}" data-s-area="${esc(a.area)}"><b>${esc(a.area)}</b><span>${a.count} toko${a.dists.length > 1 ? ` &middot; ${a.dists.length} distributor` : ''}</span></button>`).join('');
  const area = cur && opts.find(a => a.area === cur.area);
  el('stockDistWrap').hidden = !area;
  if (area) {
    el('stockDistTitle').textContent = area.dists.length > 1 ? `2. Pilih distributor di ${area.area}` : `2. Distributor di ${area.area}`;
    el('stockDistList').innerHTML = area.dists.map(d =>
      `<button type="button" class="store-card${cur.dist && cur.dist.code === d.code || (!cur.dist && !d.code) ? ' selected' : ''}" data-s-dist="${esc(d.code)}"><span class="sc-name">${esc(d.name)}</span>` +
      `<span class="sc-meta"><span>${d.count} toko di ${esc(area.area)}</span>${d.code ? `<span>${esc(d.code)}</span>` : ''}</span></button>`).join('');
  }
  const ready = !!(cur && cur.key);
  el('stockTargetCard').innerHTML = ready
    ? `<small>Stock akan disimpan untuk</small><b>${esc(cur.area)} &middot; ${esc(cur.dist ? cur.dist.name : 'Belum terdata distributornya')}</b><span>${cur.count} toko memakai data ini</span>`
    : '<small>Tujuan unggah</small><b>Belum dipilih</b><span>Pilih area, lalu distributor, sebelum mengunggah file.</span>';
  el('stockTargetCard').classList.toggle('ready', ready);
  el('stockFileInput').disabled = !ready;
  el('stockFileHint').hidden = ready;
}

function onStockTargetClick(e) {
  const a = e.target.closest('[data-s-area]');
  const d = e.target.closest('[data-s-dist]');
  if (a) {
    const area = stockOptions().find(x => x.area === a.dataset.sArea);
    if (!area) return;
    // Satu distributor saja di area ini: langsung terpilih. Lebih dari satu: SBA wajib memilih sendiri.
    stockTarget = { area: area.area, dist: null, key: '', count: 0 };
    if (area.dists.length === 1) setStockDist(area, area.dists[0]);
    else renderStockTarget();
    resetStockFile();
    if (area.dists.length === 1) refreshStockTab();
  } else if (d && stockTarget) {
    const area = stockOptions().find(x => x.area === stockTarget.area);
    const dist = area && area.dists.find(x => x.code === d.dataset.sDist);
    if (dist) { setStockDist(area, dist); resetStockFile(); refreshStockTab(); }
  }
}
function setStockDist(area, d) {
  stockTarget = { area: area.area, dist: d.code ? { code: d.code, name: d.name } : null, key: stockKey(area.area, d.code), count: d.count };
  renderStockTarget();
}
function resetStockFile() {
  pendingStockParse = null; stockAckMismatch = false;
  el('stockFileInput').value = '';
  el('stockParsePreview').textContent = '';
  el('stockMatch').innerHTML = '';
  el('stockSaveBtn').disabled = true;
}

async function refreshStockTab() {
  renderStockTarget();
  const t = stockTarget;
  if (!t || !t.key) { el('stockCurrentInfo').textContent = 'Pilih area dan distributor dulu.'; return; }
  el('stockSaveBtn').disabled = true;
  el('stockCurrentInfo').textContent = 'Memuat...';
  const existing = distributorCache[t.key] !== undefined ? distributorCache[t.key] : await loadDistributorStock(t.area, t.dist);
  if (!stockTarget || stockTarget.key !== t.key) return;   // tujuan berganti saat memuat
  distributorCache[t.key] = existing;
  if (existing) {
    const count = Object.keys(existing.items || {}).length;
    const ts = existing.uploadedAt && existing.uploadedAt.toDate ? existing.uploadedAt.toDate().toLocaleString('id-ID') : '-';
    const rd = formatReportDate(existing.reportDate);
    el('stockCurrentInfo').textContent = `Data tersimpan untuk tujuan ini: ${count} produk${rd ? `, laporan tanggal ${rd}` : ''}. Diupload: ${ts}. File: ${existing.sourceFileName || '-'}. Unggahan baru akan MENIMPA data ini.`;
  } else {
    el('stockCurrentInfo').textContent = 'Belum ada data stock untuk tujuan ini.';
  }
}

// Cocokkan distributor di file (sheet "Selected Parameters") dengan tujuan yang dipilih.
function stockMatchState(parsed) {
  const t = stockTarget;
  if (!t || !t.dist) return { state: 'unknown' };
  if (!parsed.distributorName && !parsed.distributorCode) return { state: 'unknown' };
  const ok = (parsed.distributorCode && parsed.distributorCode === t.dist.code) || sameDistributor(parsed.distributorName, t.dist.name);
  if (ok) return { state: 'ok' };
  let suggestion = null;
  for (const a of stockOptions()) for (const d of a.dists) {
    if (d.code && ((parsed.distributorCode && parsed.distributorCode === d.code) || sameDistributor(parsed.distributorName, d.name))) suggestion = { area: a, dist: d };
  }
  return { state: 'bad', suggestion };
}
function renderStockMatch() {
  const box = el('stockMatch');
  if (!pendingStockParse) { box.innerHTML = ''; return; }
  const m = stockMatchState(pendingStockParse), t = stockTarget;
  const fileDist = pendingStockParse.distributorName ? `${pendingStockParse.distributorName}${pendingStockParse.distributorCode ? ' (' + pendingStockParse.distributorCode + ')' : ''}` : null;
  if (m.state === 'ok') {
    box.innerHTML = `<div class="match-box ok"><b>Cocok.</b> File ini dari ${esc(fileDist)}, sama dengan tujuan ${esc(t.area)} &middot; ${esc(t.dist.name)}.</div>`;
  } else if (m.state === 'bad') {
    box.innerHTML = `<div class="match-box bad"><b>Distributor tidak cocok.</b> File ini dari <b>${esc(fileDist)}</b>, tetapi tujuan yang Anda pilih <b>${esc(t.area)} &middot; ${esc(t.dist.name)}</b>. Kemungkinan area atau distributor salah pilih.` +
      (m.suggestion ? `<button type="button" class="primary" data-match-move="1">Pindahkan tujuan ke ${esc(m.suggestion.area.area)} &middot; ${esc(m.suggestion.dist.name)}</button>` : '') +
      `<label class="ack"><input type="checkbox" data-match-ack${stockAckMismatch ? ' checked' : ''}><span>Saya yakin, tetap simpan ke ${esc(t.area)} &middot; ${esc(t.dist.name)}</span></label></div>`;
  } else {
    box.innerHTML = `<div class="match-box warn"><b>Distributor tidak bisa dicek.</b> ${t.dist ? 'File tidak menyebut nama distributor.' : 'Distributor tujuan belum terdata.'} Pastikan tujuan di atas sudah benar sebelum menyimpan.</div>`;
  }
  el('stockSaveBtn').disabled = m.state === 'bad' && !stockAckMismatch;
}
function onStockMatchClick(e) {
  if (e.target.closest('[data-match-move]')) {
    const m = stockMatchState(pendingStockParse);
    if (m.suggestion) { setStockDist(m.suggestion.area, m.suggestion.dist); stockAckMismatch = false; refreshStockTab(); renderStockMatch(); showToast('Tujuan dipindahkan ke ' + m.suggestion.area.area + ' - ' + m.suggestion.dist.name, 'success'); }
  } else if (e.target.matches('[data-match-ack]')) {
    stockAckMismatch = e.target.checked; renderStockMatch();
  }
}

function onStockFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!stockTarget || !stockTarget.key) { showToast('Pilih area dan distributor dulu', 'danger'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = parseDistributorWorkbook(ev.target.result);
      pendingStockParse = { ...parsed, fileName: file.name };
      stockAckMismatch = false;
      const t = stockTarget;
      const old = distributorCache[t.key];
      const rd = formatReportDate(parsed.reportDate);
      const label = `${t.area} - ${t.dist ? t.dist.name : 'tanpa distributor'}`;
      let msg = `Berhasil dibaca: ${parsed.rowCount} produk${rd ? `, laporan tanggal ${rd}` : ''}${parsed.distributorName ? ` (${parsed.distributorName})` : ''}.`;
      if (parsed.duplicates) msg += ` ${parsed.duplicates} PCODE ganda (yang terakhir dipakai).`;
      msg += old
        ? ` Simpan akan MENIMPA seluruh data stock ${label} sebelumnya (${Object.keys(old.items || {}).length} produk${old.reportDate ? `, laporan ${formatReportDate(old.reportDate)}` : ''}).`
        : ` Ini data pertama untuk ${label}.`;
      if (old && old.reportDate && parsed.reportDate && parsed.reportDate < old.reportDate) {
        msg += ` PERHATIAN: laporan ini LEBIH LAMA dari data tersimpan.`;
      }
      el('stockParsePreview').textContent = msg;
      el('stockSaveBtn').disabled = false;
      renderStockMatch();
    } catch (err) {
      el('stockParsePreview').textContent = `Gagal membaca file: ${err.message || 'format tidak dikenali'} Pastikan file adalah UID Distributor Stock Report (kolom PCODE, Karton, Lusin, PCs).`;
      el('stockMatch').innerHTML = '';
      el('stockSaveBtn').disabled = true;
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// Tombol Simpan membuka konfirmasi dulu: tujuan ditulis jelas sekali lagi sebelum data menimpa yang lama.
function onStockSave() {
  if (!pendingStockParse || !stockTarget || !stockTarget.key) return;
  const t = stockTarget;
  el('stockConfirmTarget').textContent = `${t.area} \u00b7 ${t.dist ? t.dist.name : 'Belum terdata distributornya'}`;
  el('stockConfirmCount').textContent = `${t.count} toko akan memakai data ini. Data stock tujuan ini sebelumnya akan ditimpa.`;
  el('stockConfirmBackdrop').classList.add('show');
}

async function onStockConfirmYes() {
  el('stockConfirmBackdrop').classList.remove('show');
  if (!pendingStockParse || !stockTarget) return;
  const t = stockTarget;
  el('stockSaveBtn').disabled = true;
  el('stockSaveBtn').textContent = 'Menyimpan...';
  try {
    const meta = { reportDate: pendingStockParse.reportDate, distributorName: pendingStockParse.distributorName };
    await saveDistributorStock(t.area, t.dist, pendingStockParse.items, pendingStockParse.fileName, meta);
    distributorCache[t.key] = { items: pendingStockParse.items, sourceFileName: pendingStockParse.fileName, ...meta, uploadedAt: { toDate: () => new Date() } };
    showToast(`Stock ${t.area}${t.dist ? ' - ' + t.dist.name : ''} berhasil disimpan (${Object.keys(pendingStockParse.items).length} produk)`, 'success');
    // Kirim juga ke Monitoring Daily. Tidak menunggu hasil untuk menutup layar, dan gagal kirim tidak membatalkan simpan.
    pushStockToMonitoring(pendingStockParse.distributorCode || (t.dist && t.dist.code), pendingStockParse.reportDate, pendingStockParse.items).then((r) => {
      if (r.status === 'ok') showToast(`Stock juga terkirim ke Monitoring Daily (${r.dt || 'DT'}, ${r.rows} produk)`, 'success');
      else if (r.status === 'skipped') showToast(`Tidak dikirim ke Monitoring Daily: ${r.reason}`, 'info');
      else if (r.status === 'error') showToast(`Stock tersimpan di sini, tapi GAGAL dikirim ke Monitoring Daily (${r.reason}). Upload ulang atau upload manual di tool Monitoring.`, 'danger');
    });
    resetStockFile();
    await refreshStockTab();
    renderSkuList();
  } catch (err) {
    console.error('Gagal menyimpan stock distributor:', err);
    showToast(`Gagal menyimpan stock (${err.code || err.message || 'error tidak diketahui'}).`, 'danger');
    el('stockSaveBtn').disabled = false;
  } finally {
    el('stockSaveBtn').textContent = 'Simpan ke database';
  }
}

// ---------- Upload Extract (data pembelian toko dari distributor -> Barang Masuk, oleh Supervisor) ----------

let pendingMasukResult = null;
let lastMasukFile = null; // File terakhir yang dipilih -- dipakai untuk baca ulang otomatis kalau periode diganti
let masukWeek = null;     // Periode extract (Senin-Minggu) yang akan diisi. TERPISAH dari Minggu di bagian atas halaman.
let masukDetected = null; // {periodKey, share, weeks:[{periodKey,count}], total} -- minggu menurut tanggal (INVDate) di file
let masukAck = false;     // SBA/supervisor menyatakan periode sengaja berbeda dari tanggal di file

const mondayOf = (d) => { const r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() - ((r.getDay() + 6) % 7)); return r; };
function weekFrom(monday) {
  const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  return { start, end: addDays(start, 6), periodKey: isoDate(start) };
}
const weekText = (w) => `${fmtShort(w.start)} - ${fmtShort(w.end)} ${w.end.getFullYear()}`;
// Pilihan periode: 5 minggu terakhir sampai minggu ini. Setiap Senin supervisor mengunggah data 7 hari sebelumnya,
// jadi bawaannya MINGGU LALU, bukan minggu yang berjalan di bagian atas halaman.
function masukWeekOptions() {
  const thisMon = mondayOf(TODAY);
  return [-4, -3, -2, -1, 0].map(n => {
    const w = weekFrom(addDays(thisMon, n * 7));
    w.rel = n === 0 ? 'Minggu ini' : n === -1 ? 'Minggu lalu' : `${-n} minggu lalu`;
    return w;
  });
}
function setMasukWeek(w, reprocess) {
  masukWeek = w; masukAck = false;
  renderMasukPeriod();
  if (reprocess && lastMasukFile) processMasukFile(lastMasukFile);
}

function refreshMasukTab() {
  if (!masukWeek) masukWeek = masukWeekOptions().find(w => w.rel === 'Minggu lalu');
  renderMasukPeriod();
}

function renderMasukPeriod() {
  const opts = masukWeekOptions();
  const w = masukWeek;
  const cur = opts.find(o => o.periodKey === w.periodKey);
  const isMonday = TODAY.getDay() === 1;
  const last = opts.find(o => o.rel === 'Minggu lalu');
  el('masukPeriodTitle').textContent = weekText(w);
  el('masukPeriodTag').textContent = cur ? cur.rel : 'Periode lain';
  el('masukPeriodTag').className = 'pc-tag ' + (cur && cur.rel === 'Minggu lalu' ? 'ok' : 'warn');
  // urutan: minggu lalu (bawaan) dulu, lalu minggu ini, lalu yang lebih lama
  const chipOrder = [opts.find(o => o.rel === 'Minggu lalu'), opts.find(o => o.rel === 'Minggu ini'), ...opts.filter(o => o.rel !== 'Minggu lalu' && o.rel !== 'Minggu ini').reverse()];
  el('masukWeekChips').innerHTML = chipOrder.map(o =>
    `<button type="button" class="chip${o.periodKey === w.periodKey ? ' active' : ''}" data-mweek="${o.periodKey}">${esc(o.rel)}<small> ${fmtShort(o.start)}-${fmtShort(o.end)}</small></button>`).join('');
  el('masukReminder').className = 'reminder' + (isMonday ? ' today' : '');
  el('masukReminder').innerHTML = `<b>${isMonday ? 'Hari ini Senin:' : 'Ingat:'}</b> supervisor mengunggah data <b>7 hari sebelumnya</b>. Minggu lalu = <b>${weekText(last)}</b>. ` +
    `Periode di sini <b>tidak ikut</b> pilihan Minggu di bagian atas halaman, jadi cek lagi sebelum menyimpan.`;
}

// Minggu (Senin-Minggu) menurut tanggal INVDate di file. Baris tanpa tanggal tidak dihitung.
function detectMasukWeeks(rows) {
  const count = {};
  let total = 0;
  for (const r of rows) {
    if (!r.invDate) continue;
    const k = isoDate(mondayOf(r.invDate));
    count[k] = (count[k] || 0) + 1; total++;
  }
  const weeks = Object.entries(count).map(([periodKey, n]) => ({ periodKey, count: n })).sort((x, y) => y.count - x.count);
  return { total, weeks, periodKey: weeks[0] ? weeks[0].periodKey : null, share: total && weeks[0] ? weeks[0].count / total : 0 };
}
const weekByKey = (key) => weekFrom(new Date(key + 'T00:00:00'));

function renderMasukCheck(rows) {
  const box = el('masukCheck');
  if (!masukDetected || !masukDetected.total) { box.innerHTML = rows ? '<div class="match-box warn"><b>Tanggal tidak terbaca.</b> File tidak punya kolom INVDate yang valid, jadi periode tidak bisa dicek otomatis. Pastikan periode di atas sudah benar.</div>' : ''; return true; }
  const d = masukDetected, sel = masukWeek.periodKey;
  const inSel = (d.weeks.find(x => x.periodKey === sel) || { count: 0 }).count;
  const fileWeek = weekByKey(d.periodKey);
  let html = '', blocked = false;
  if (d.periodKey === sel && d.share >= 0.9) {
    html = `<div class="match-box ok"><b>Periode cocok.</b> Tanggal di file (${esc(weekText(fileWeek))}) sama dengan periode yang dipilih.</div>`;
  } else if (d.periodKey === sel) {
    html = `<div class="match-box warn"><b>File berisi lebih dari satu minggu.</b> ${inSel} dari ${d.total} baris jatuh di ${esc(weekText(masukWeek))}; sisanya di luar periode dan diabaikan.</div>`;
  } else {
    blocked = !masukAck;
    html = `<div class="match-box bad"><b>Periode tidak cocok dengan tanggal di file.</b> Tanggal di file sebagian besar ada di <b>${esc(weekText(fileWeek))}</b> (${d.weeks[0].count} dari ${d.total} baris), tetapi periode yang dipilih <b>${esc(weekText(masukWeek))}</b> (${inSel} baris cocok).` +
      `<button type="button" class="primary" data-mpick="${d.periodKey}">Pakai periode ${esc(weekText(fileWeek))}</button>` +
      `<label class="ack"><input type="checkbox" data-mack${masukAck ? ' checked' : ''}><span>Saya yakin, tetap simpan ke ${esc(weekText(masukWeek))}</span></label></div>`;
  }
  box.innerHTML = html;
  return !blocked;
}
function onMasukBoxClick(e) {
  const chip = e.target.closest('[data-mweek]');
  if (chip) { const w = masukWeekOptions().find(o => o.periodKey === chip.dataset.mweek); if (w) setMasukWeek(w, true); return; }
  const pick = e.target.closest('[data-mpick]');
  if (pick) { setMasukWeek(weekByKey(pick.dataset.mpick), true); showToast('Periode diganti sesuai tanggal di file', 'success'); return; }
  if (e.target.matches('[data-mack]')) { masukAck = e.target.checked; updateMasukSave(); renderMasukCheck(true); }
}
function updateMasukSave() {
  const ok = pendingMasukResult && pendingMasukResult.matchedStoreNames.length > 0 && (!masukDetected || !masukDetected.total || masukDetected.periodKey === masukWeek.periodKey || masukAck);
  el('masukSaveBtn').disabled = !ok;
}

async function processPurchaseRows(rows) {
  const weekStart = masukWeek.start;
  const weekEnd = new Date(masukWeek.end.getFullYear(), masukWeek.end.getMonth(), masukWeek.end.getDate(), 23, 59, 59);
  let outOfRange = 0;
  const unmatchedStoreSet = new Set();
  let nonWajibCount = 0;
  const perStoreQty = {}; // storeId -> { barcode: totalQty }
  const codeMapCache = {}; // storeId -> Map(skuCode -> barcode)
  const distInFile = {};   // kode distributor di file -> {name, rows}
  const distMismatch = new Set(); // toko yang distributor di file beda dari yang tercatat di daftar toko

  for (const row of rows) {
    if (row.distId) { const d = distInFile[row.distId] = distInFile[row.distId] || { name: row.distName, rows: 0 }; d.rows++; }
    if (row.invDate && (row.invDate < weekStart || row.invDate > weekEnd)) {
      outOfRange++;
      continue;
    }
    const store = stores.find(s => s.id === row.outlet);
    if (!store) {
      unmatchedStoreSet.add(row.outlet);
      continue;
    }
    const known = distCodeOf(store);
    if (row.distId && known && row.distId !== known) distMismatch.add(store.name);
    if (!codeMapCache[store.id]) {
      const skuList = await skuListForStoreWeek(store, masukWeek.periodKey);
      const map = new Map();
      for (const s of skuList) {
        for (const c of (s.codes || [])) map.set(c.code, s.barcode);
      }
      // pcode selalu dipakai sebagai cadangan (data lama tanpa daftar codes)
      for (const s of skuList) if (s.pcode && !map.has(s.pcode)) map.set(s.pcode, s.barcode);
      codeMapCache[store.id] = map;
    }
    const barcode = codeMapCache[store.id].get(row.skuCode);
    if (!barcode) {
      nonWajibCount++;
      continue;
    }
    if (!perStoreQty[store.id]) perStoreQty[store.id] = {};
    perStoreQty[store.id][barcode] = (perStoreQty[store.id][barcode] || 0) + row.qty;
  }

  const matchedStoreNames = Object.keys(perStoreQty).map(id => (stores.find(s => s.id === id) || {}).name || id);
  return { perStoreQty, outOfRange, unmatchedStores: [...unmatchedStoreSet], nonWajibCount, matchedStoreNames, totalRows: rows.length, distInFile, distMismatch: [...distMismatch] };
}

function onMasukFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  lastMasukFile = file;
  masukAck = false;
  processMasukFile(file);
}

function processMasukFile(file) {
  el('masukParsePreview').textContent = 'Membaca file...';
  el('masukSaveBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const { rows, headerMissing } = parsePurchaseWorkbook(ev.target.result);
      if (headerMissing) {
        el('masukParsePreview').textContent = 'Format file tidak dikenali. Pastikan ada kolom Outlet, SKUCode, TotalQuantity(PCS).';
        el('masukCheck').innerHTML = '';
        showToast('Format file tidak dikenali. Cek kolomnya.', 'danger');
        return;
      }
      masukDetected = detectMasukWeeks(rows);
      const result = await processPurchaseRows(rows);
      pendingMasukResult = result;
      const label = weekText(masukWeek);
      const skuCombos = Object.values(result.perStoreQty).reduce((n, m) => n + Object.keys(m).length, 0);
      el('masukParsePreview').textContent = `${rows.length} baris dibaca. ${result.matchedStoreNames.length} toko terdeteksi, ${skuCombos} kombinasi toko+SKU siap disimpan.`;
      let detail = '';
      const dists = Object.entries(result.distInFile);
      if (dists.length) detail += `<p class="upload-status">Distributor di file: ${dists.map(([k, v]) => `${esc(v.name || k)} (${k})`).join(', ')}. Distributor tidak perlu dipilih: toko dikenali dari kode Outlet di file.</p>`;
      if (result.distMismatch.length) detail += `<p class="upload-status" style="color:var(--warning);font-weight:600;">${result.distMismatch.length} toko tercatat di distributor lain pada daftar toko: ${esc(result.distMismatch.slice(0, 5).join(', '))}${result.distMismatch.length > 5 ? ' dan lainnya' : ''}. Data tetap dihitung, tapi cek file distributornya benar.</p>`;
      if (result.outOfRange > 0) detail += `<p class="upload-status">${result.outOfRange} baris di luar rentang ${label} diabaikan.</p>`;
      if (result.unmatchedStores.length) {
        const shown = result.unmatchedStores.slice(0, 8).join(', ');
        const more = result.unmatchedStores.length > 8 ? ` &middot; dan ${result.unmatchedStores.length - 8} kode outlet lain (di luar toko SBA COTC)` : '';
        detail += `<p class="upload-status">${result.unmatchedStores.length} kode outlet tidak dikenal diabaikan: ${shown}${more}</p>`;
      }
      if (result.nonWajibCount > 0) detail += `<p class="upload-status">${result.nonWajibCount} baris di luar SKU wajib toko terkait diabaikan.</p>`;
      if (result.matchedStoreNames.length) detail += `<p class="upload-status">Toko terdeteksi: ${result.matchedStoreNames.join(', ')}</p>`;
      el('masukPreviewDetail').innerHTML = detail;
      renderMasukCheck(true);
      updateMasukSave();

      // Pop-up notifikasi juga (bukan cuma teks di bawah, supaya tidak kelewat) --
      // warna beda tergantung ada data siap simpan atau tidak sama sekali.
      if (skuCombos > 0) {
        showToast(`${rows.length} baris dibaca untuk ${label}: ${skuCombos} kombinasi toko+SKU siap disimpan.`, 'success');
      } else {
        showToast(`${rows.length} baris dibaca, tapi 0 yang cocok dengan ${label}. Cek periode yang dipilih sudah benar?`, 'danger');
      }
    } catch (err) {
      console.error(err);
      el('masukParsePreview').textContent = 'Gagal membaca file. Pastikan formatnya sesuai.';
      showToast('Gagal membaca file. Pastikan formatnya sesuai.', 'danger');
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
  const week = masukWeek;
  const periodKey = week.periodKey;
  const storeIds = Object.keys(result.perStoreQty);

  // Langkah 1: simpan ke Firestore. INI SATU-SATUNYA yang menentukan toast sukses/gagal.
  try {
    await Promise.all(storeIds.map(async storeId => {
      const store = stores.find(s => s.id === storeId);
      const listVersion = store ? await listVersionForStoreWeek(store, periodKey) : null;
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
        weekStart: week.start.toISOString(),
        weekEnd: week.end.toISOString(),
        items,
        ...(listVersion ? { listVersion } : {}),
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

  showToast(`Barang masuk tersimpan untuk ${storeIds.length} toko, periode ${weekText(week)}`, 'success');
  pendingMasukResult = null;
  masukDetected = null;
  masukAck = false;
  lastMasukFile = null;
  el('masukFileInput').value = '';
  el('masukParsePreview').textContent = '';
  el('masukPreviewDetail').innerHTML = '';
  el('masukCheck').innerHTML = '';
  btn.textContent = 'Simpan ke database';
  btn.disabled = true;

  // Langkah 2: hitung ulang Jual (best-effort, tidak boleh mengubah toast di atas kalau gagal)
  Promise.all(storeIds.map(async storeId => {
    const store = stores.find(s => s.id === storeId);
    if (!store) return;
    const skuList = await skuListForStoreWeek(store, week.periodKey);
    return computeAndSaveJualForStorePeriod(storeId, week.start, skuList);
  })).catch(err => console.error('Gagal hitung ulang Jual setelah upload Masuk:', err));

  // Langkah 3: refresh tampilan toko yang sedang dibuka, kalau termasuk yang baru diupdate dan minggunya yang sedang tampil
  // (best-effort juga -- data sudah AMAN tersimpan di langkah 1, ini cuma soal tampilan).
  if (currentStore && currentWeek && currentWeek.periodKey === periodKey && result.perStoreQty[currentStore.id]) {
    try {
      await loadEntryForCurrentPeriod();
      renderAll();
    } catch (err) {
      console.error('Data tersimpan, tapi gagal me-refresh tampilan:', err);
    }
  }
}

init();
