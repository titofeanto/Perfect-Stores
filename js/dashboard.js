import { db, doc, getDoc, collection, query, where, getDocs, authReady } from './firebase-init.js';
import { loadStores, loadSkuList } from './store-data.js';
import { getWeeksForMonth, findWeekContaining, fmtShort, MONTHS_ID } from './weeks.js';
import { summarizeEntry, buildOosDetail } from './entry-utils.js';

const TODAY = new Date();
const el = (id) => document.getElementById(id);

let stores = [];
let skuListCache = {}; // scopeSlug -> sku list
let currentWeeks = [];
let distStockByArea = {};
let rowsByStoreId = {};

async function init() {
  await authReady;
  stores = await loadStores();
  // Preload semua daftar SKU wajib (cuma 3 file kecil) supaya perhitungan % per toko tidak perlu fetch berulang
  const uniqueSlugs = [...new Set(stores.map(s => s.scopeSlug))];
  await Promise.all(uniqueSlugs.map(async slug => { skuListCache[slug] = await loadSkuList(slug); }));
  await loadDistributorStockAll();

  populateMonthSelect();
  populateWeekSelect();
  el('monthSel').addEventListener('change', () => { populateWeekSelect(); loadAndRender(); });
  el('weekSel').addEventListener('change', loadAndRender);
  el('oosModalClose').addEventListener('click', () => el('oosModal').classList.remove('show'));

  await loadAndRender();
}

// distributorStock cuma menyimpan snapshot TERBARU (bukan histori per minggu) --
// dimuat sekali saja, bukan tergantung minggu yang dipilih.
async function loadDistributorStockAll() {
  const areas = ['Sorong', 'Timika'];
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
  el('loadingNote').textContent = 'Memuat data 36 toko...';
  el('dashboardContent').style.display = 'none';

  const week = currentWeeks[+el('weekSel').value];
  const periodKey = week.periodKey;

  let entriesByStore = {};
  try {
    const q = query(collection(db, 'entries'), where('periodKey', '==', periodKey));
    const snap = await getDocs(q);
    snap.forEach(d => { entriesByStore[d.data().storeId] = d.data(); });
  } catch (err) {
    console.error('Gagal memuat rekap:', err);
    el('loadingNote').textContent = 'Gagal memuat data. Cek koneksi internet lalu refresh halaman.';
    return;
  }

  const rows = stores.map(store => {
    const entry = entriesByStore[store.id] || null;
    const skuList = skuListCache[store.scopeSlug] || [];
    const summary = summarizeEntry(entry ? entry.items : null, skuList);
    const oosDetail = buildOosDetail(entry ? entry.items : null, skuList, distStockByArea[store.area] || {});
    let status = 'notstarted';
    if (entry && entry.submitted) status = 'submitted';
    else if (entry) status = 'progress';
    return { store, entry, summary, status, oosDetail };
  });
  rowsByStoreId = Object.fromEntries(rows.map(r => [r.store.id, r]));

  renderMetrics(rows);
  renderAreaSummary(rows);
  renderFlagAvailability(rows);
  renderTable(rows, week);

  el('loadingNote').style.display = 'none';
  el('dashboardContent').style.display = 'block';
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

// Persentase SKU yang stock-nya > 0 (tersedia di toko), diagregasi lintas 36 toko, per flag.
// "Belum diisi" tidak dihitung sebagai tersedia maupun tidak tersedia -- cuma dikeluarkan
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

function renderTable(rows, week) {
  // Toko yang sudah diisi ditampilkan lebih dulu (kebalikan dari sebelumnya), lalu
  // di dalam grup yang sama, yang paling lengkap duluan.
  const statusPriority = { submitted: 0, progress: 1, notstarted: 2 };
  const sorted = [...rows].sort((a, b) => {
    const sp = statusPriority[a.status] - statusPriority[b.status];
    if (sp !== 0) return sp;
    return b.summary.pct - a.summary.pct;
  });

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
        <td><a class="open-link" href="${link}">Buka &rarr;</a></td>
      </tr>
    `;
  }).join('');

  el('recapTableBody').querySelectorAll('.oos-link').forEach(btn => {
    btn.addEventListener('click', () => openOosModal(btn.dataset.storeId, week));
  });
}

function dtStatusBadge(dtQty) {
  if (dtQty === null || dtQty === undefined) {
    return '<span class="status-pill notstarted">Data DT tidak ada</span>';
  }
  if (dtQty > 0) {
    return '<span class="status-pill submitted">Ada di DT &middot; push salesman</span>';
  }
  return '<span class="status-pill progress" style="background:var(--danger-bg); color:var(--danger);">OOS DT juga</span>';
}

function openOosModal(storeId, week) {
  const row = rowsByStoreId[storeId];
  if (!row) return;
  el('oosModalTitle').textContent = `SKU tidak ada di toko - ${row.store.name}`;
  el('oosModalSubtitle').textContent = `${week.label} (${fmtShort(week.start)} - ${fmtShort(week.end)}) &middot; dicocokkan ke stock distributor TERKINI (bukan histori minggu itu)`;
  if (!row.oosDetail.length) {
    el('oosModalBody').innerHTML = '<p class="upload-status">Tidak ada SKU dengan stock 0 untuk toko ini.</p>';
  } else {
    el('oosModalBody').innerHTML = row.oosDetail.map(d => `
      <div class="sku-item">
        <p class="sku-name">${d.name}</p>
        <p class="sku-code">${d.barcode}${d.pcode ? ' &middot; PC ' + d.pcode : ''}</p>
        <div>${dtStatusBadge(d.dtQty)}</div>
        ${d.dtQty !== null ? `<p class="upload-status">Stock distributor (${row.store.area}): ${d.dtQty} pcs</p>` : ''}
      </div>
    `).join('');
  }
  el('oosModal').classList.add('show');
}

init();
