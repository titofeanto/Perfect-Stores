// Gambar rekap "SKU kosong di toko" untuk dibagikan ke salesman lewat WhatsApp.
// Digambar langsung di <canvas> (tanpa library tambahan) supaya ringan dan tidak bergantung CDN.
// Format: 1080x1920 (rasio 16:9 tegak, pas untuk layar HP), maksimal 15 SKU per gambar;
// kalau SKU kosong lebih dari 15, dibuat beberapa gambar berurutan: N = ceil(jumlah SKU / 15).
import { fmtTotal } from './dt-stock.js?v=1';

export const MAX_SKU_PER_IMAGE = 15;

// Urutan: SKU yang ada stock di DT dulu (stock DT terbanyak di atas, dibandingkan dalam
// karton supaya adil antar ukuran kemasan; kalau isi per karton tidak diketahui, dalam pcs),
// lalu yang kosong di DT. Setelah itu dipotong per MAX_SKU_PER_IMAGE SKU jadi halaman-halaman.
export function paginateShareItems(oosDetail, perPage = MAX_SKU_PER_IMAGE) {
  const cartons = (d) => (d.isi ? d.dtQty / d.isi : d.dtQty);
  const available = oosDetail.filter(d => d.hasDtData && d.dtQty > 0)
    .sort((a, b) => cartons(b) - cartons(a) || b.dtQty - a.dtQty);
  const notAvailable = oosDetail.filter(d => !(d.hasDtData && d.dtQty > 0))
    .sort((a, b) => a.name.localeCompare(b.name));
  const all = available.concat(notAvailable);
  const pages = [];
  for (let i = 0; i < all.length; i += perPage) pages.push(all.slice(i, i + perPage));
  return { pages, totalOos: all.length, totalAvailable: available.length, totalDtEmpty: notAvailable.length };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const W = 1080;
const H = 1920;
const PAD = 48;
const ROW_H = 100;
const FOOTER_H = 130;

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth || !cur) cur = test;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

// 1 baris teks: font dikecilkan sampai muat; kalau masih tidak muat di ukuran minimum, dipotong "…".
function fitLine(ctx, text, fontFn, maxWidth, startPx, minPx) {
  let px = startPx;
  ctx.font = fontFn(px);
  while (px > minPx && ctx.measureText(text).width > maxWidth) { px -= 1; ctx.font = fontFn(px); }
  let out = String(text);
  while (out.length > 1 && ctx.measureText(out).width > maxWidth) out = out.slice(0, -1);
  return { text: out === String(text) ? out : out.slice(0, -1) + '…', px };
}

// info: {storeName, area, weekLabel, weekRange}; page: array SKU halaman ini;
// pageNo (mulai 1), pageCount, offset = jumlah SKU di halaman sebelumnya, picked = hasil paginateShareItems()
function renderPage(info, page, pageNo, pageCount, offset, picked) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  // Header (tinggi mengikuti jumlah baris nama toko: 1 atau 2)
  ctx.font = `700 42px ${FONT}`;
  const titleLines = wrapText(ctx, info.storeName, W - PAD * 2 - 130, 2);
  const SUB_Y = 108 + (titleLines.length - 1) * 50 + 46;
  const COUNT_Y = SUB_Y + 42;
  const HEADER_H = COUNT_Y + 30;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#161a24';
  ctx.fillRect(0, 0, W, HEADER_H);
  ctx.fillStyle = '#9fb0c8';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('SKU KOSONG DI TOKO', PAD, 58);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 42px ${FONT}`;
  titleLines.forEach((l, i) => ctx.fillText(l, PAD, 108 + i * 50));
  ctx.fillStyle = '#c9d3e3';
  ctx.font = `26px ${FONT}`;
  ctx.fillText(`${info.area} · ${info.weekLabel} (${info.weekRange})`, PAD, SUB_Y);
  ctx.fillStyle = '#7fe0a3';
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText(`SKU ${offset + 1}-${offset + page.length} dari ${picked.totalOos} SKU kosong`, PAD, COUNT_Y);
  // Penanda halaman di kanan atas
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(`${pageNo}/${pageCount}`, W - PAD, 66);
  ctx.textAlign = 'left';

  // Baris SKU (tinggi tetap supaya semua gambar seragam)
  const TEXT_X = PAD + 62;
  const TEXT_W = W - PAD - TEXT_X;
  page.forEach((d, i) => {
    const y = HEADER_H + i * ROW_H;
    if (i % 2 === 1) { ctx.fillStyle = '#f5f6f8'; ctx.fillRect(0, y, W, ROW_H); }
    ctx.fillStyle = '#8a8f99';
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText(String(offset + i + 1), PAD, y + 40);

    const name = fitLine(ctx, d.name, px => `600 ${px}px ${FONT}`, TEXT_W, 30, 22);
    ctx.fillStyle = '#161a24';
    ctx.font = `600 ${name.px}px ${FONT}`;
    ctx.fillText(name.text, TEXT_X, y + 38);

    if (d.hasDtData && d.dtQty > 0) {
      ctx.fillStyle = '#005d2d';
      ctx.font = `700 26px ${FONT}`;
      ctx.fillText(`Stock DT: ${fmtTotal(d.dtQty, d.isi)}  (${d.dtQty} pcs)`, TEXT_X, y + 68);
      const withStock = d.codes.filter(c => c.qtyPcs > 0);
      const shown = withStock.slice(0, 3).map(c => `${c.code} (${c.qtyPcs} pcs)`);
      const more = withStock.length - shown.length;
      const codes = fitLine(ctx, 'SKU Code: ' + shown.join(' · ') + (more > 0 ? ` · +${more}` : ''),
        px => `${px}px ${MONO}`, TEXT_W, 20, 15);
      ctx.fillStyle = '#545860';
      ctx.font = `${codes.px}px ${MONO}`;
      ctx.fillText(codes.text, TEXT_X, y + 92);
    } else {
      ctx.fillStyle = '#b3261e';
      ctx.font = `700 26px ${FONT}`;
      const msg = d.hasDtData
        ? 'Stock DT kosong - Request SPO / tanya kapan datang'
        : 'Data stock DT belum di-upload';
      ctx.fillText(msg, TEXT_X, y + 68);
    }
  });

  // Footer (menempel di bawah supaya ukuran semua gambar sama)
  const fy = H - FOOTER_H;
  ctx.fillStyle = '#e3e5ea';
  ctx.fillRect(PAD, fy, W - PAD * 2, 2);
  ctx.fillStyle = '#545860';
  ctx.font = `22px ${FONT}`;
  const notes = [
    'Urut dari stock DT terbanyak. Stock DT = total semua SKU Code sebarcode.',
    pageNo < pageCount ? `Lanjut ke gambar ${pageNo + 1}/${pageCount}.` : 'Selesai.',
  ];
  notes.forEach((n, i) => ctx.fillText(wrapText(ctx, n, W - PAD * 2, 1)[0], PAD, fy + 44 + i * 34));

  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Gagal membuat gambar'))), 'image/png');
  });
}

// Mengembalikan array Blob PNG, satu per halaman (urut).
export async function renderShareImages(info, picked) {
  const blobs = [];
  let offset = 0;
  for (let i = 0; i < picked.pages.length; i++) {
    blobs.push(await renderPage(info, picked.pages[i], i + 1, picked.pages.length, offset, picked));
    offset += picked.pages[i].length;
  }
  return blobs;
}

function slug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 40) || 'toko';
}

// Di HP: buka menu bagikan bawaan dengan SEMUA gambar terlampir sekaligus (pilih WhatsApp ->
// pilih kontak). Web tidak bisa memaksa aplikasi tujuan, jadi WhatsApp dipilih dari menu itu.
// Di komputer / browser tanpa dukungan: gambar diunduh, lalu WhatsApp dibuka dengan teks -- gambarnya
// tinggal ditempel/di-drag ke chat.
// Mengembalikan 'shared' | 'downloaded' | 'cancelled'.
export async function shareToWhatsApp(blobs, storeName, caption) {
  const base = `sku-kosong-${slug(storeName)}`;
  const files = blobs.map((b, i) => new File([b], `${base}-${i + 1}-dari-${blobs.length}.png`, { type: 'image/png' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, text: caption });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      console.error('Share gagal, pakai unduhan:', err);
    }
  }
  files.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    setTimeout(() => { a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }, i * 400);
  });
  window.open('https://wa.me/?text=' + encodeURIComponent(caption), '_blank', 'noopener');
  return 'downloaded';
}
