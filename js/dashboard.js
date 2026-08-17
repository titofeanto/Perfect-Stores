import { db, collection, query, where, getDocs, authReady } from './firebase-init.js';
import { loadStores, loadSkuList } from './store-data.js';
import { getWeeksForMonth, findWeekContaining, fmtShort, MONTHS_ID } from './weeks.js';
import { summarizeEntry } from './entry-utils.js';

const TODAY = new Date();
const el = (id) => document.getElementById(id);

let stores = [];
let skuListCache = {}; // scopeSlug -> sku list
let currentWeeks = [];

async function init() {
  await authReady;
  stores = await loadStores();
  // Preload semua daftar SKU wajib (cuma 3 file kecil) supaya perhitungan % per toko tidak perlu fetch berulang
  const uniqueSlugs = [...new Set(stores.map(s => s.scopeSlug))];
  await Promise.all(uniqueSlugs.map(async slug => { skuListCache[slug] = await loadSkuList(slug); }));

  populateMonthSelect();
  populateWeekSelect();
  el('monthSel').addEventListener('change', () => { populateWeekSelect(); loadAndRender(); });
  el('weekSel').addEventListener('change', loadAndRender);

  await loadAndRender();
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
    let status = 'notstarted';
    if (entry && entry.submitted) status = 'submitted';
    else if (entry) status = 'progress';
    return { store, entry, summary, status };
  });

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
  el('mTotal').textContent = total;
  el('mSubmitted').textContent = submitted;
  el('mNotSubmitted').textContent = notSubmitted;
  el('mAvgPct').textContent = avgPct + '%';
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
  const statusPriority = { notstarted: 0, progress: 1, submitted: 2 };
  const sorted = [...rows].sort((a, b) => {
    const sp = statusPriority[a.status] - statusPriority[b.status];
    if (sp !== 0) return sp;
    return a.summary.pct - b.summary.pct;
  });

  el('recapTableBody').innerHTML = sorted.map(r => {
    const link = `index.html?store=${encodeURIComponent(r.store.id)}&period=${encodeURIComponent(week.periodKey)}`;
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
        <td>${r.summary.tidakAda}</td>
        <td><a class="open-link" href="${link}">Buka &rarr;</a></td>
      </tr>
    `;
  }).join('');
}

init();
