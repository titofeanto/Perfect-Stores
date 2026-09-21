// Popup "SKU tidak ada di toko" + tombol bagikan ke WhatsApp. Dipakai dashboard.js (rekap lintas
// toko) dan app.js (tab Rekap SBA), supaya tampilan dan hitungan stock DT-nya selalu sama.
// Butuh markup #oosModal (lihat dashboard.html / index.html).
import { esc, dtCodesHtml, fmtTotal } from './dt-stock.js?v=1';
import { MAX_SKU_PER_IMAGE, paginateShareItems, renderShareImages, shareToWhatsApp } from './share-image.js?v=4';
import { buildPushOrderWorkbook, shareExcel } from './share-excel.js?v=2';
import { fmtShort } from './weeks.js';

const el = (id) => document.getElementById(id);
const FLAG_LABELS = { 'COTC': 'COTC', 'MARKET MAKING': 'Market making', 'NPD': 'NPD' };
const FLAG_BADGE_CLASS = { 'COTC': 'flag-cotc', 'MARKET MAKING': 'flag-market', 'NPD': 'flag-npd' };

let currentShare = null; // {store, week, picked} untuk popup yang sedang dibuka (picked = hasil paginateShareItems)

export function dtStatusBadge(d) {
  if (!d.hasDtData) {
    return '<span class="status-pill notstarted">Data stock DT belum di-upload</span>';
  }
  if (d.dtQty > 0) {
    return '<span class="status-pill submitted">Ada stock di DT - Salesman/SBA Nego Order ke Buyer</span>';
  }
  return '<span class="status-pill progress" style="background:var(--danger-bg); color:var(--danger);">Stock DT tidak ada / kosong - Request SPO / tanya kapan datang</span>';
}

// Tutup bisa dari: tombol X di pojok kanan atas (selalu kelihatan, header menempel), klik area gelap
// di luar popup, tombol Escape, atau tombol "Tutup" di bawah. Tombol "Bawah" langsung menggulung
// popup ke paling bawah (tombol bagikan) tanpa scroll manual.
export function wireOosModal() {
  const close = () => el('oosModal').classList.remove('show');
  el('oosModalClose').addEventListener('click', close);
  el('oosCloseX').addEventListener('click', close);
  el('oosModal').addEventListener('click', (e) => { if (e.target === el('oosModal')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  el('oosScrollBtn').addEventListener('click', () => {
    const box = el('oosBox');
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  });
  el('oosShareBtn').addEventListener('click', onShareOos);
  el('oosShareExcelBtn').addEventListener('click', onShareExcel);
}

// store: {name, area}; week: {label, start, end}; oosDetail: hasil buildOosDetail() (entry-utils.js)
export function showOosModal({ store, week, oosDetail }) {
  const picked = paginateShareItems(oosDetail);
  currentShare = { store, week, picked, oosDetail };
  const n = picked.pages.length;
  el('oosShareBtn').disabled = n === 0;
  el('oosShareExcelBtn').disabled = n === 0;
  el('oosShareBtn').textContent = n > 1 ? `Bagikan ke WhatsApp (${n} gambar)` : 'Bagikan ke WhatsApp (gambar)';
  el('oosShareNote').textContent = n
    ? `${picked.totalOos} SKU kosong dibagi ${MAX_SKU_PER_IMAGE} SKU per gambar = ${n} gambar (format HP 1080x1920), urut dari stock DT terbanyak.`
    : 'Tidak ada SKU kosong di toko ini, jadi tidak ada yang perlu dibagikan.';
  el('oosModalTitle').textContent = `SKU tidak ada di toko - ${store.name}`;
  el('oosModalSubtitle').innerHTML = `${esc(week.label)} (${fmtShort(week.start)} - ${fmtShort(week.end)}) &middot; dicocokkan ke stock distributor ${esc(store.area)} TERKINI (bukan histori minggu itu)`;
  if (!oosDetail.length) {
    el('oosModalBody').innerHTML = '<p class="upload-status">Tidak ada SKU dengan stock 0 untuk toko ini.</p>';
  } else {
    el('oosModalBody').innerHTML = oosDetail.map(d => `
      <div class="sku-item">
        <p class="sku-name">${esc(d.name)}</p>
        <p class="sku-code">${esc(d.barcode)} <span class="badge ${FLAG_BADGE_CLASS[d.flag] || 'flag-cotc'}">${esc(FLAG_LABELS[d.flag] || d.flag || 'COTC')}</span></p>
        <div>${dtStatusBadge(d)}</div>
        ${d.dtQty > 0 ? `<p class="upload-status">Total stock DT ${esc(store.area)}: ${fmtTotal(d.dtQty, d.isi)} (= ${d.dtQty} pcs)</p>` : ''}
        ${dtCodesHtml(d)}
      </div>
    `).join('');
  }
  el('oosBox').scrollTop = 0;
  el('oosModal').classList.add('show');
}

async function onShareOos() {
  if (!currentShare || !currentShare.picked.pages.length) return;
  const { store, week, picked } = currentShare;
  const btn = el('oosShareBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Menyiapkan gambar...';
  try {
    const blobs = await renderShareImages({
      storeName: store.name,
      area: store.area,
      weekLabel: week.label,
      weekRange: `${fmtShort(week.start)} - ${fmtShort(week.end)}`,
    }, picked);
    const caption = `Halo, berikut ${picked.totalOos} SKU yang kosong di ${store.name} (${week.label}), ${blobs.length} gambar. `
      + 'Yang ada stock di DT mohon dibantu order; yang kosong di DT mohon Request SPO / tanya kapan datang. '
      + 'Mohon pastikan juga barcode-nya sudah terdaftar (listing) di toko. Terima kasih.';
    const result = await shareToWhatsApp(blobs, store.name, caption);
    if (result === 'downloaded') {
      el('oosShareNote').textContent = `${blobs.length} gambar sudah terunduh dan WhatsApp dibuka. Tempel/drag gambar ke chat salesman.`;
    }
  } catch (err) {
    console.error('Gagal membagikan rekap:', err);
    el('oosShareNote').textContent = 'Gagal membuat gambar: ' + (err.message || err);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

// Excel list SKU push order: dikirim ke salesman supaya PO ke toko bisa segera diterbitkan.
async function onShareExcel() {
  if (!currentShare || !currentShare.picked.pages.length) return;
  const { store, week, oosDetail } = currentShare;
  const btn = el('oosShareExcelBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Menyiapkan Excel...';
  try {
    const { blob, filename, total, available } = buildPushOrderWorkbook({
      store, week, weekRange: `${fmtShort(week.start)} - ${fmtShort(week.end)}`, oosDetail,
    });
    const caption = `Halo, terlampir list SKU push order untuk ${store.name} (${week.label}): ${total} SKU kosong di toko, ${available} di antaranya ada stock di DT. `
      + 'Mohon dibantu terbitkan PO ke toko (kolom Qty Order bisa diisi), dan pastikan barcode-nya sudah terdaftar (listing) di toko. Terima kasih.';
    const result = await shareExcel(blob, filename, caption);
    if (result === 'downloaded') {
      el('oosShareNote').textContent = `File ${filename} sudah terunduh dan WhatsApp dibuka. Drag file ke chat salesman.`;
    }
  } catch (err) {
    console.error('Gagal membagikan Excel:', err);
    el('oosShareNote').textContent = 'Gagal membuat Excel: ' + (err.message || err);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}
