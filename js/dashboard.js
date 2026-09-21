import { db, doc, getDoc, collection, query, where, getDocs, authReady } from './firebase-init.js';
import { pickAccount, storeIsAllowed, switchAccount } from './store-filter.js?v=2';
import { loadStores, loadSkuList } from './store-data.js';
import { getWeeksForMonth, findWeekContaining, fmtShort, MONTHS_ID } from './weeks.js';
import { summarizeEntry, buildOosDetail, normalizeField, fieldTotal, fieldIsEmpty } from './entry-utils.js?v=3';
import { wireOosModal, showOosModal } from './oos-modal.js?v=5';
import { downloadAsExcel } from './export-utils.js';
import { esc, fmtTotal } from './dt-stock.js?v=1';

const TODAY = new Date();
const el = (id) => document.getElementById(id);

let stores = [];
let skuListCache = {}; // scopeSlug -> sku list
let currentWeeks = [];
let distStockByArea = {};
let rowsByStoreId = {};
let entriesByStore = null; // hasil fetch minggu terpilih; null = belum dimuat
// Filter dashboard. Set berisi nilai yang DIPILIH; semua terpilih = tidak ada filter.
const NO_BU = 'Lainnya';
let allAreas = [];
let allBus = [];
let selectedAreas = new Set();
let selectedBus = new Set();
let allFlags = [];
let selectedFlags = new Set();
let oppShowAll = false;
let selectedStoreIds = new Set();
let storeQuery = '';

async function init() {
  await authReady;
  const { mapping } = await pickAccount();
  const allStores = await loadStores();
  stores = allStores.filter(s => storeIsAllowed(s.id));
  const nameLabel = document.getElementById('loggedInAs');
  if (nameLabel) nameLabel.textContent = mapping ? (mapping.name + (mapping.isMaster ? ' (semua toko)' : '')) : 'Semua toko';
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', switchAccount);
  if (!stores.length) {
    document.querySelector('.app').innerHTML = '<div class="card" style="margin-top:40px;"><p>Akun ini belum ter-mapping ke toko mana pun. Hubungi admin.</p></div>';
    return;
  }
  // Preload semua daftar SKU wajib (cuma 3 file kecil) supaya perhitungan % per toko tidak perlu fetch berulang
  const uniqueSlugs = [...new Set(stores.map(s => s.scopeSlug))];
  await Promise.all(uniqueSlugs.map(async slug => { skuListCache[slug] = await loadSkuList(slug); }));
  await loadDistributorStockAll();
  initFilters();

  populateMonthSelect();
  populateWeekSelect();
  el('monthSel').addEventListener('change', () => { populateWeekSelect(); loadAndRender(); });
  el('weekSel').addEventListener('change', loadAndRender);
  wireOosModal();
  el('exportAllBtn').addEventListener('click', exportAllStores);

  await loadAndRender();
}

// distributorStock hanya menyimpan snapshot terbaru (bukan histori per minggu),
// jadi dimuat sekali saja, tidak tergantung minggu yang dipilih.
async function loadDistributorStockAll() {
  const areas = [...new Set(stores.map(s => s.area))]; // semua area toko yang bisa dilihat akun ini
  const results = await Promise.all(areas.map(async area => {
    try {
      const snap = await getDoc(doc(db, 'distributorStock', area));
      return [area, snap.exists() ? (snap.data().items || {}) : {}];
    } catch (err) {
      console.error('Gagal memuat stock distributor', area, err);
      return [area, {}];
    }
  }));
  distStockByArea = Object.fromEntries(results);
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
}

async function loadAndRender() {
  el('loadingNote').style.display = 'block';
  el('loadingNote').textContent = 'Memuat data toko...';
  el('dashboardContent').style.display = 'none';

  const week = currentWeeks[+el('weekSel').value];
  const periodKey = week.periodKey;

  const fetched = {};
  try {
    const q = query(collection(db, 'entries'), where('periodKey', '==', periodKey));
    const snap = await getDocs(q);
    snap.forEach(d => { fetched[d.data().storeId] = d.data(); });
  } catch (err) {
    console.error('Gagal memuat rekap:', err);
    el('loadingNote').textContent = 'Gagal memuat data. Cek koneksi internet lalu refresh halaman.';
    return;
  }
  entriesByStore = fetched;

  renderDashboard();

  el('loadingNote').style.display = 'none';
  el('dashboardContent').style.display = 'block';
}

// Susun ulang rekap dari data minggu yang sudah di-fetch, sesuai filter Area / Flag SKU / Bisnis Unit / Toko.
// Filter Flag SKU dan Bisnis Unit menyaring SKU wajib (bukan toko), jadi Lengkap / OSA / Tidak ada ikut
// dihitung ulang hanya dari SKU yang lolos (mis. hanya flag COTC). Toko tanpa SKU di BU terpilih tidak ditampilkan.
function renderDashboard() {
  if (!entriesByStore) return;
  const week = currentWeeks[+el('weekSel').value];
  const rows = [];
  for (const store of activeStores()) {
    const skuList = (skuListCache[store.scopeSlug] || []).filter(sku =>
      selectedBus.has(sku.bu || NO_BU) && selectedFlags.has(sku.flag || 'COTC'));
    if (!skuList.length) continue;
    const entry = entriesByStore[store.id] || null;
    const summary = summarizeEntry(entry ? entry.items : null, skuList);
    const oosDetail = buildOosDetail(entry ? entry.items : null, skuList, distStockByArea[store.area] || {});
    let status = 'notstarted';
    if (entry && entry.submitted) status = 'submitted';
    else if (entry) status = 'progress';
    rows.push({ store, entry, summary, status, oosDetail });
  }
  rowsByStoreId = Object.fromEntries(rows.map(r => [r.store.id, r]));

  renderMetrics(rows);
  renderAreaSummary(rows);
  renderFlagAvailability(rows);
  renderOpportunities(rows);
  renderTable(rows, week);
  renderFilterInfo(rows.length);
}

// ---------- Filter (Area / Bisnis Unit / Toko) ----------

function initFilters() {
  allAreas = [...new Set(stores.map(s => s.area))].sort();
  const buSet = new Set();
  for (const list of Object.values(skuListCache)) for (const sku of list) buSet.add(sku.bu || NO_BU);
  allBus = [...buSet].sort();
  const flagSet = new Set();
  for (const list of Object.values(skuListCache)) for (const sku of list) flagSet.add(sku.flag || 'COTC');
  allFlags = [...flagSet].sort((a, b) => {
    const ia = FLAG_ORDER.indexOf(a), ib = FLAG_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  resetFilters(false);

  el('storeQuery').addEventListener('input', (e) => { storeQuery = e.target.value; renderStoreChecklist(); renderDashboard(); });
  el('storePickAll').addEventListener('click', () => { visibleStores().forEach(s => selectedStoreIds.add(s.id)); renderStoreChecklist(); renderDashboard(); });
  el('storePickNone').addEventListener('click', () => { visibleStores().forEach(s => selectedStoreIds.delete(s.id)); renderStoreChecklist(); renderDashboard(); });
  el('filterReset').addEventListener('click', () => resetFilters(true));
  el('oppMore').addEventListener('click', () => { oppShowAll = !oppShowAll; renderDashboard(); });
}

function resetFilters(rerender) {
  selectedAreas = new Set(allAreas);
  selectedBus = new Set(allBus);
  selectedFlags = new Set(allFlags);
  oppShowAll = false;
  selectedStoreIds = new Set(stores.map(s => s.id));
  storeQuery = '';
  el('storeQuery').value = '';
  renderFilterChips();
  renderStoreChecklist();
  if (rerender) renderDashboard();
}

// Semua terpilih + klik satu chip = tampilkan hanya yang itu. Selain itu chip bekerja sebagai
// toggle; kalau semua dicopot, kembali ke "semua". Chip "Semua" memilih semuanya lagi.
function toggleChoice(set, all, value) {
  if (set.size === all.length) { set.clear(); set.add(value); }
  else if (set.has(value)) { set.delete(value); if (!set.size) all.forEach(v => set.add(v)); }
  else set.add(value);
}

function chipRowHtml(all, set, dataAttr, labelOf) {
  const allActive = set.size === all.length;
  return `<span class="chip ${allActive ? 'active' : ''}" ${dataAttr}="__all__">Semua</span>`
    + all.map(v => `<span class="chip ${!allActive && set.has(v) ? 'active' : ''}" ${dataAttr}="${esc(v)}">${esc(labelOf ? labelOf(v) : v)}</span>`).join('');
}

function renderFilterChips() {
  el('areaChips').innerHTML = chipRowHtml(allAreas, selectedAreas, 'data-area');
  el('flagChips').innerHTML = chipRowHtml(allFlags, selectedFlags, 'data-flag', f => FLAG_LABELS[f] || f);
  el('buChips').innerHTML = chipRowHtml(allBus, selectedBus, 'data-bu');
  el('areaChips').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.area;
      if (v === '__all__') selectedAreas = new Set(allAreas); else toggleChoice(selectedAreas, allAreas, v);
      renderFilterChips();
      renderStoreChecklist();
      renderDashboard();
    });
  });
  el('flagChips').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.flag;
      if (v === '__all__') selectedFlags = new Set(allFlags); else toggleChoice(selectedFlags, allFlags, v);
      oppShowAll = false;
      renderFilterChips();
      renderDashboard();
    });
  });
  el('buChips').querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.bu;
      if (v === '__all__') selectedBus = new Set(allBus); else toggleChoice(selectedBus, allBus, v);
      renderFilterChips();
      renderDashboard();
    });
  });
}

// Toko yang lolos filter Area + kotak cari (dasar untuk daftar centang di bawah).
function visibleStores() {
  const q = storeQuery.trim().toLowerCase();
  return stores.filter(s => selectedAreas.has(s.area) && (!q || s.name.toLowerCase().includes(q)));
}

// Toko yang benar-benar ditampilkan di dashboard: lolos filter Area + cari + dicentang.
function activeStores() {
  return visibleStores().filter(s => selectedStoreIds.has(s.id));
}

function renderStoreChecklist() {
  const list = visibleStores().sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name));
  el('storeChecklist').innerHTML = list.length
    ? list.map(s => `
      <label class="store-check">
        <input type="checkbox" data-store-id="${esc(s.id)}" ${selectedStoreIds.has(s.id) ? 'checked' : ''}>
        <span>${esc(s.name)}</span>
        <span class="store-check-area">${esc(s.area)}</span>
      </label>`).join('')
    : '<p class="upload-status" style="margin:8px 0;">Tidak ada toko yang cocok.</p>';
  el('storeChecklist').querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedStoreIds.add(cb.dataset.storeId); else selectedStoreIds.delete(cb.dataset.storeId);
      renderDashboard();
    });
  });
}

function renderFilterInfo(shownCount) {
  const visible = visibleStores();
  const checked = visible.filter(s => selectedStoreIds.has(s.id)).length;
  el('storePickerSummary').textContent = `Pilih toko manual (${checked} dari ${visible.length} dicentang)`;
  el('filterInfo').textContent = `Menampilkan ${shownCount} dari ${stores.length} toko.`;
}

function renderMetrics(rows) {
  const total = rows.length;
  const submitted = rows.filter(r => r.status === 'submitted').length;
  const notSubmitted = total - submitted;
  const avgPct = total ? Math.round(rows.reduce((sum, r) => sum + r.summary.pct, 0) / total) : 0;
  const totalSku = rows.reduce((s, r) => s + r.summary.total, 0);
  const totalAda = rows.reduce((s, r) => s + r.summary.ada, 0);
  const osaPct = totalSku ? Math.round((totalAda / totalSku) * 100) : 0;
  el('mTotal').textContent = total;
  el('mSubmitted').textContent = submitted;
  el('mNotSubmitted').textContent = notSubmitted;
  el('mAvgPct').textContent = avgPct + '%';
  el('mOsa').textContent = `${osaPct}%`;
  el('mOsaDetail').textContent = `${totalAda}/${totalSku} SKU-toko tersedia`;
}

function renderAreaSummary(rows) {
  const areas = [...new Set(rows.map(r => r.store.area))].sort();
  el('areaSummary').innerHTML = areas.map(area => {
    const areaRows = rows.filter(r => r.store.area === area);
    const submitted = areaRows.filter(r => r.status === 'submitted').length;
    const avgPct = Math.round(areaRows.reduce((s, r) => s + r.summary.pct, 0) / areaRows.length);
    return `<div style="display:flex; justify-content:space-between; padding:6px 0; border-top:1px solid var(--border);">
      <span style="font-size:13px;">${area} (${areaRows.length} toko)</span>
      <span style="font-size:12px; color:var(--text-secondary);">${submitted}/${areaRows.length} kirim &middot; rata-rata ${avgPct}%</span>
    </div>`;
  }).join('');
}

function statusPillHtml(status) {
  if (status === 'submitted') return '<span class="status-pill submitted">Sudah kirim</span>';
  if (status === 'progress') return '<span class="status-pill progress">Sedang diisi</span>';
  return '<span class="status-pill notstarted">Belum mulai</span>';
}

const FLAG_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD' };
const FLAG_ORDER = ['COTC', 'MARKET MAKING', 'NPD'];

// Persentase SKU yang stock-nya > 0 (tersedia di toko), diagregasi lintas semua toko, per flag.
// "Belum diisi" tidak dihitung sebagai tersedia maupun tidak tersedia, hanya dikeluarkan
// dari pembilang, supaya persentase tidak salah tafsir sebelum data lengkap semua.
function renderFlagAvailability(rows) {
  const agg = {};
  for (const r of rows) {
    for (const [flag, stats] of Object.entries(r.summary.byFlag || {})) {
      if (!agg[flag]) agg[flag] = { total: 0, ada: 0, belumIsi: 0 };
      agg[flag].total += stats.total;
      agg[flag].ada += stats.ada;
      agg[flag].belumIsi += stats.belumIsi;
    }
  }
  const flags = FLAG_ORDER.filter(f => agg[f]);
  el('flagAvailability').innerHTML = flags.map(flag => {
    const stats = agg[flag];
    const pct = stats.total ? Math.round((stats.ada / stats.total) * 100) : 0;
    return `
      <div style="margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
          <span>${FLAG_LABELS[flag] || flag}</span>
          <span style="color:var(--text-secondary);">${stats.ada}/${stats.total} toko-SKU tersedia &middot; ${pct}%</span>
        </div>
        <div class="pct-bar-track" style="width:100%; height:8px;"><div class="pct-bar-fill" style="width:${pct}%;"></div></div>
      </div>
    `;
  }).join('') || '<p class="upload-status">Belum ada data untuk periode ini.</p>';
}

const FLAG_BADGE_CLASS = { 'COTC': 'flag-cotc', 'MARKET MAKING': 'flag-market', 'NPD': 'flag-npd' };
const OPP_LIMIT = 30;

// Peluang order: SKU yang kosong di toko (stock 0) dirangkum lintas toko yang lolos filter, lengkap dengan
// stock DT per area -- supaya jelas SKU mana (mis. flag COTC) yang bisa dikejar ordernya sekarang.
// Urutan: paling banyak toko yang bisa dikejar (ada stock DT di area tokonya) di atas.
function renderOpportunities(rows) {
  const bySku = new Map();
  for (const r of rows) {
    for (const d of r.oosDetail) {
      let o = bySku.get(d.barcode);
      if (!o) { o = { barcode: d.barcode, name: d.name, flag: d.flag || 'COTC', isi: d.isi, stores: [] }; bySku.set(d.barcode, o); }
      o.stores.push({ name: r.store.name, area: r.store.area, dtQty: d.dtQty, hasDtData: d.hasDtData });
    }
  }
  const all = [...bySku.values()].map(o => ({ ...o, chase: o.stores.filter(s => s.hasDtData && s.dtQty > 0).length }));
  const chasable = all.filter(o => o.chase > 0)
    .sort((a, b) => b.chase - a.chase || b.stores.length - a.stores.length || a.name.localeCompare(b.name));
  const noDt = all.length - chasable.length;
  const picked = allFlags.length && selectedFlags.size < allFlags.length
    ? [...selectedFlags].map(f => FLAG_LABELS[f] || f).join(' + ') : 'semua flag';
  el('oppTitle').textContent = `Peluang order - ${picked}`;
  const storeSku = all.reduce((s, o) => s + o.stores.length, 0);
  el('oppSummary').textContent = all.length
    ? `${chasable.length} SKU bisa dikejar (ada stock di DT) dari ${all.length} SKU yang kosong di toko (${storeSku} kombinasi toko-SKU).`
      + (noDt ? ` ${noDt} SKU kosong juga di DT: Request SPO / tanya kapan datang.` : '')
    : 'Tidak ada SKU kosong di toko untuk filter ini.';

  const shown = oppShowAll ? chasable : chasable.slice(0, OPP_LIMIT);
  el('oppList').innerHTML = shown.map(o => {
    const byArea = {};
    for (const s of o.stores) {
      const a = byArea[s.area] || (byArea[s.area] = { dtQty: s.dtQty, hasDtData: s.hasDtData, names: [] });
      a.names.push(s.name);
    }
    const areas = Object.entries(byArea).sort((x, y) => y[1].dtQty - x[1].dtQty);
    const dtParts = areas.filter(([, a]) => a.dtQty > 0).map(([area, a]) => `${esc(area)} ${a.dtQty} pcs`);
    const areaHtml = areas.map(([area, a]) => {
      const status = !a.hasDtData ? '<span class="empty">data DT belum di-upload</span>'
        : a.dtQty > 0 ? `<span class="stock">stock DT ${fmtTotal(a.dtQty, o.isi)} (= ${a.dtQty} pcs)</span>`
        : '<span class="empty">DT kosong - Request SPO</span>';
      return `<div class="opp-area"><b>${esc(area)}: ${status}</b><span class="stores">${a.names.map(esc).join(', ')}</span></div>`;
    }).join('');
    return `
      <details class="opp-item">
        <summary>
          <span class="opp-top">
            <span class="badge ${FLAG_BADGE_CLASS[o.flag] || 'flag-cotc'}">${esc(FLAG_LABELS[o.flag] || o.flag)}</span>
            <span class="opp-name">${esc(o.name)}</span>
            <span class="opp-caret">&#9656;</span>
          </span>
          <span class="opp-meta">Kosong di <b>${o.stores.length} toko</b> &middot; bisa dikejar di ${o.chase} toko &middot; DT: ${dtParts.join(', ') || '-'}</span>
        </summary>
        <div class="opp-detail">
          <span class="opp-code">Barcode ${esc(o.barcode)}</span>
          ${areaHtml}
        </div>
      </details>`;
  }).join('');
  const more = el('oppMore');
  if (chasable.length > OPP_LIMIT) {
    more.style.display = 'block';
    more.textContent = oppShowAll ? `Tampilkan ${OPP_LIMIT} teratas saja` : `Tampilkan semua ${chasable.length} SKU`;
  } else {
    more.style.display = 'none';
  }
}

function renderTable(rows, week) {
  // Toko yang sudah diisi ditampilkan lebih dulu, lalu
  // di dalam grup yang sama, yang paling lengkap duluan.
  const statusPriority = { submitted: 0, progress: 1, notstarted: 2 };
  const sorted = [...rows].sort((a, b) => {
    const sp = statusPriority[a.status] - statusPriority[b.status];
    if (sp !== 0) return sp;
    return b.summary.pct - a.summary.pct;
  });

  if (!sorted.length) {
    el('recapTableBody').innerHTML = '<tr><td colspan="7" style="white-space:normal;">Tidak ada toko yang cocok dengan filter.</td></tr>';
    return;
  }

  el('recapTableBody').innerHTML = sorted.map(r => {
    const link = `index.html?store=${encodeURIComponent(r.store.id)}&period=${encodeURIComponent(week.periodKey)}`;
    const tidakAdaCell = r.summary.tidakAda > 0
      ? `<button type="button" class="oos-link" data-store-id="${r.store.id}">${r.summary.tidakAda}</button>`
      : r.summary.tidakAda;
    return `
      <tr>
        <td class="name-cell">${r.store.name}</td>
        <td>${r.store.area}</td>
        <td>${statusPillHtml(r.status)}</td>
        <td>
          <div class="pct-bar-wrap">
            <div class="pct-bar-track"><div class="pct-bar-fill" style="width:${r.summary.pct}%;"></div></div>
            <span>${r.summary.lengkap}/${r.summary.total}</span>
          </div>
        </td>
        <td>
          <div class="pct-bar-wrap">
            <div class="pct-bar-track"><div class="pct-bar-fill" style="width:${r.summary.osaPct}%;"></div></div>
            <span>${r.summary.osaPct}%</span>
          </div>
        </td>
        <td>${tidakAdaCell}</td>
        <td>
          <a class="open-link" href="${link}">Buka &rarr;</a>
          <button type="button" class="export-store-link" data-store-id="${r.store.id}">Export</button>
        </td>
      </tr>
    `;
  }).join('');

  el('recapTableBody').querySelectorAll('.oos-link').forEach(btn => {
    btn.addEventListener('click', () => openOosModal(btn.dataset.storeId, week));
  });
  el('recapTableBody').querySelectorAll('.export-store-link').forEach(btn => {
    btn.addEventListener('click', () => exportOneStore(btn.dataset.storeId, btn));
  });
}

function fieldValue(raw, isi) {
  const f = normalizeField(raw);
  return fieldIsEmpty(f) ? '' : fieldTotal(f, isi);
}

// Export 1 toko: semua periode/minggu yang pernah diisi (bukan cuma bulan yang sedang dipilih).
async function exportOneStore(storeId, triggerEl) {
  const store = stores.find(s => s.id === storeId);
  if (!store) return;
  const original = triggerEl ? triggerEl.textContent : null;
  if (triggerEl) { triggerEl.textContent = '...'; triggerEl.style.pointerEvents = 'none'; }
  try {
    const skuList = skuListCache[store.scopeSlug] || [];
    const q = query(collection(db, 'entries'), where('storeId', '==', storeId));
    const snap = await getDocs(q);
    const rows = [];
    snap.forEach(d => {
      const data = d.data();
      const items = data.items || {};
      for (const sku of skuList) {
        const it = items[sku.barcode] || {};
        rows.push({
          Toko: store.name,
          Area: store.area,
          ScopeChannel: store.scopeChannel,
          Periode: data.periodKey || '',
          MingguMulai: data.weekStart ? data.weekStart.slice(0, 10) : '',
          MingguSelesai: data.weekEnd ? data.weekEnd.slice(0, 10) : '',
          Flag: sku.flag || '',
          Barcode: sku.barcode,
          PCCode: sku.pcode || '',
          NamaProduk: sku.name,
          Stock_pcs: fieldValue(it.stock, sku.isi),
          Order_pcs: fieldValue(it.order, sku.isi),
          Masuk_pcs: fieldValue(it.masuk, sku.isi),
          Jual_pcs: fieldValue(it.jual, sku.isi),
          SudahKirim: data.submitted ? 'Ya' : 'Tidak'
        });
      }
    });
    if (!rows.length) {
      alert(`Belum ada data yang bisa di-export untuk ${store.name}.`);
      return;
    }
    downloadAsExcel(rows, `rekap_${store.name.replace(/[^a-z0-9]+/gi, '_')}.xlsx`, 'Rekap');
  } catch (err) {
    console.error('Gagal export toko:', err);
    alert('Gagal export: ' + (err.message || err));
  } finally {
    if (triggerEl) { triggerEl.textContent = original; triggerEl.style.pointerEvents = ''; }
  }
}

// Export semua toko: cuma untuk bulan yang sedang dipilih di dropdown (lintas semua minggu bulan itu).
async function exportAllStores() {
  const btn = el('exportAllBtn');
  const original = btn.textContent;
  btn.textContent = 'Menyiapkan export...';
  btn.disabled = true;
  try {
    const allRows = [];
    for (const week of currentWeeks) {
      const q = query(collection(db, 'entries'), where('periodKey', '==', week.periodKey));
      const snap = await getDocs(q);
      snap.forEach(d => {
        const data = d.data();
        const store = stores.find(s => s.id === data.storeId);
        if (!store) return;
        const skuList = skuListCache[store.scopeSlug] || [];
        const items = data.items || {};
        for (const sku of skuList) {
          const it = items[sku.barcode] || {};
          allRows.push({
            Toko: store.name,
            Area: store.area,
            ScopeChannel: store.scopeChannel,
            Periode: week.periodKey,
            MingguMulai: fmtShort(week.start),
            MingguSelesai: fmtShort(week.end),
            Flag: sku.flag || '',
            Barcode: sku.barcode,
            PCCode: sku.pcode || '',
            NamaProduk: sku.name,
            Stock_pcs: fieldValue(it.stock, sku.isi),
            Order_pcs: fieldValue(it.order, sku.isi),
            Masuk_pcs: fieldValue(it.masuk, sku.isi),
            Jual_pcs: fieldValue(it.jual, sku.isi),
            SudahKirim: data.submitted ? 'Ya' : 'Tidak'
          });
        }
      });
    }
    if (!allRows.length) {
      alert('Belum ada data yang bisa di-export untuk bulan ini.');
      return;
    }
    downloadAsExcel(allRows, `rekap_semua_toko_${el('monthSel').value}.xlsx`, 'Rekap');
  } catch (err) {
    console.error('Gagal export semua toko:', err);
    alert('Gagal export: ' + (err.message || err));
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

function openOosModal(storeId, week) {
  const row = rowsByStoreId[storeId];
  if (!row) return;
  showOosModal({ store: row.store, week, oosDetail: row.oosDetail });
}

init();
