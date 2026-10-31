// Gerbang kode admin untuk halaman Akun + pengaturan banner maintenance.
// Kode diperiksa di Apps Script (hanya hash-nya yang tersimpan), tidak ada kode di repo.
import { MONITORING } from '../backend-config.js';
const ENDPOINT = MONITORING.endpoint;
const KEY = 'sba_admin_kode';
const $ = (id) => document.getElementById(id);
let kode = '';
let mode = 'mati';

const HINT = { mati: 'Tidak ada pemberitahuan.', banner: 'Spanduk kuning di atas layar. Aplikasi tetap bisa dipakai.', blokir: 'Layar penuh. Aplikasi tidak bisa dipakai sampai dimatikan.' };
const TPL = {
  1: ['Perbaikan', 'Aplikasi sedang diperbaiki. Fitur tertentu mungkin belum bisa dipakai. Data Anda aman.'],
  2: ['Maintenance', 'Maintenance terjadwal sampai jam __.__ WIT. Mohon tidak input data selama itu.'],
  3: ['Data belum update', 'Data sedang diperbarui. Angka di layar mungkin belum yang terbaru.'],
};

function post(body) {
  return fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch((e) => ({ error: 'network', message: 'Tidak bisa terhubung (' + e.message + ').' }));
}

function setMode(m) {
  mode = m;
  $('adminText').hidden = m === 'mati';
  $('adminModeHint').textContent = HINT[m];
  document.querySelectorAll('#adminModes [data-m]').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
}

function showNow() {
  fetch(ENDPOINT + '?view=status&t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    $('adminNow').textContent = !j.aktif ? 'Normal. Tidak ada pemberitahuan.' : (j.blokir ? 'APLIKASI DITUTUP: ' : 'Banner aktif: ') + j.judul + ' - ' + j.pesan;
    if (j.aktif && !$('adminPesan').value) { setMode(j.blokir ? 'blokir' : 'banner'); $('adminJudul').value = j.judul; $('adminPesan').value = j.pesan; }
  }).catch(() => { $('adminNow').textContent = 'Gagal membaca status.'; });
}

function open_() {
  $('adminGate').hidden = true;
  $('adminBody').hidden = false;
  setMode('mati');
  showNow();
}

function gateFail(msg) {
  $('gateErr').textContent = msg;
  const card = document.querySelector('.gate-card');
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
}

async function tryCode(k) {
  $('gateErr').textContent = 'Memeriksa…';
  $('gateGo').disabled = true;
  const j = await post({ action: 'cekKodeAdmin', kode: k });
  $('gateGo').disabled = false;
  if (j.ok) { kode = k; try { sessionStorage.setItem(KEY, k); } catch (e) { /* abaikan */ } open_(); return true; }
  gateFail(j.error === 'belum_diatur' ? 'Kode admin belum diatur. Isi kode lalu tekan "Atur kode pertama".'
    : j.error === 'unknown_action' ? 'Server belum diperbarui. Deploy ulang Apps Script Monitoring Harian.' : (j.message || 'Kode salah.'));
  $('gateClaim').hidden = j.error !== 'belum_diatur';
  return false;
}

function init() {
  $('gateEye').addEventListener('click', () => {
    const show = $('gateKode').type === 'password';
    $('gateKode').type = show ? 'text' : 'password';
    $('gateEye').setAttribute('aria-pressed', String(show));
  });
  $('gateForm').addEventListener('submit', (e) => { e.preventDefault(); tryCode($('gateKode').value); });
  $('gateClaim').addEventListener('click', async () => {
    const k = $('gateKode').value;
    const j = await post({ action: 'klaimKodeAdmin', kodeBaru: k });
    if (j.ok) tryCode(k); else $('gateErr').textContent = j.message || 'Gagal mengatur kode.';
  });
  $('adminModes').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) setMode(b.dataset.m); });
  $('adminTpl').addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) { $('adminJudul').value = TPL[b.dataset.t][0]; $('adminPesan').value = TPL[b.dataset.t][1]; } });
  $('adminSave').addEventListener('click', async () => {
    if (mode === 'blokir' && !confirm('Aplikasi akan ditutup untuk semua pengguna. Lanjut?')) return;
    $('adminErr').textContent = 'Menyimpan…';
    const j = await post({ action: 'setStatus', kode, mode, judul: $('adminJudul').value, pesan: $('adminPesan').value });
    $('adminErr').textContent = j.error ? (j.message || j.error) : 'Tersimpan. Pengguna melihatnya dalam ±1 menit.';
    if (!j.error) showNow();
  });
  $('adminLock').addEventListener('click', () => { try { sessionStorage.removeItem(KEY); } catch (e) { /* abaikan */ } location.reload(); });
  let saved = '';
  try { saved = sessionStorage.getItem(KEY) || ''; } catch (e) { /* abaikan */ }
  if (saved) tryCode(saved);
}
init();
