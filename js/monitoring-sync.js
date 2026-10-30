import { MONITORING } from './backend-config.js';

// Setiap stock distributor yang disimpan di sini juga dikirim ke Monitoring Daily (tab STOK_GUDANG),
// supaya tim tidak upload dua kali. Hanya DT yang terdaftar di Monitoring yang diterima; DT lain diabaikan.
// Gagal kirim TIDAK menggagalkan simpan di Firestore: hasilnya hanya dilaporkan ke layar.
// Content-Type text/plain sengaja dipakai agar browser tidak mengirim preflight CORS (Apps Script tidak menjawab OPTIONS).
export async function pushStockToMonitoring(distCode, reportDate, items) {
  if (!MONITORING || !MONITORING.endpoint) return { status: 'off' };
  if (!distCode || !reportDate) return { status: 'skipped', reason: 'Kode distributor atau tanggal laporan tidak terbaca dari file.' };
  const rows = Object.entries(items).map(([pcode, it]) => [pcode, it.karton || 0, it.lusin || 0, it.pcs || 0, it.isi || 1]);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), MONITORING.timeoutMs || 25000);
  try {
    const res = await fetch(MONITORING.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'simpanStok', dt: String(distCode), tanggal: reportDate, rows }),
      signal: ctl.signal
    });
    const j = await res.json();
    if (j.error) return { status: 'error', reason: j.message || j.error };
    if (j.skipped) return { status: 'skipped', reason: j.reason };
    return { status: 'ok', rows: j.rows, dt: j.dtNama };
  } catch (err) {
    return { status: 'error', reason: err.name === 'AbortError' ? 'Waktu habis' : (err.message || 'Tidak bisa terhubung') };
  } finally {
    clearTimeout(timer);
  }
}
