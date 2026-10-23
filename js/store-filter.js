import { loadMaster } from './master-data.js';
// Penyaring toko yang RINGAN -- BUKAN otentikasi sungguhan. Cuma mempersempit
// daftar toko yang tampil, berdasarkan file data/user-mapping.json yang Anda edit
// & upload manual ke GitHub. Siapa pun yang paham teknis tetap bisa lihat data
// toko lain kalau mau -- ini murni kenyamanan tampilan, bukan pembatasan akses.
//
// Sengaja "fail open": kalau file mapping tidak ada / gagal load / usernya tidak
// ketemu, TETAP tampilkan SEMUA toko -- supaya tidak ada yang ke-lock out cuma
// karena mapping belum diisi/salah ketik.

let cachedMapping = null; // {name, storeIds, isMaster} milik akun yang dipilih, atau null (= semua toko)
let allMappings = {};

async function loadAllMappings() {
  try {
    const master = await loadMaster();   // mapping dari tab Mapping_Akun bila Google Sheets aktif
    if (master && master.mapping) return master.mapping;
    const res = await fetch('data/user-mapping.json');
    if (!res.ok) return {};
    return await res.json();
  } catch (err) {
    console.error('Gagal memuat user-mapping.json (lanjut tanpa filter):', err);
    return {};
  }
}

function injectPickerMarkup(usernames) {
  if (document.getElementById('accountGate')) return;
  const div = document.createElement('div');
  div.id = 'accountGate';
  div.className = 'login-gate';
  div.innerHTML = `
    <div class="login-box">
      <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7l2-3h12l2 3"/><path d="M5 7v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7"/><path d="M9 14l2 2 4-4"/></svg></span>
      <h1>Perfect Stores</h1>
      <p style="margin:0 0 18px;">Pilih akun Anda supaya daftar toko lebih ringkas (opsional).</p>
      <label class="field-label">Akun</label>
      <select id="accountSelect" style="margin-bottom:14px;">
        <option value="">-- Tampilkan semua toko --</option>
        ${usernames.map(u => `<option value="${u}">${u}</option>`).join('')}
      </select>
      <button id="accountContinueBtn" class="primary" style="width:100%;">Lanjut</button>
    </div>
  `;
  document.body.appendChild(div);

  document.getElementById('accountContinueBtn').addEventListener('click', () => {
    const chosen = document.getElementById('accountSelect').value;
    if (chosen) localStorage.setItem('sba_selected_account', chosen);
    else localStorage.removeItem('sba_selected_account');
    document.getElementById('accountGate').remove();
    applyMapping(chosen);
  });
}

let resolveReady = null;
function applyMapping(username) {
  cachedMapping = (username && allMappings[username]) ? allMappings[username] : null;
  if (resolveReady) resolveReady({ mapping: cachedMapping });
}

// Panggil di awal tiap halaman (pengganti requireLogin/authReady yang lama).
// Resolve dengan {mapping} -- mapping null artinya "tampilkan semua toko".
export function pickAccount() {
  return new Promise(async (resolve) => {
    resolveReady = resolve;
    allMappings = await loadAllMappings();
    const usernames = Object.keys(allMappings);

    const saved = localStorage.getItem('sba_selected_account');
    if (saved && allMappings[saved]) {
      applyMapping(saved);
      return;
    }
    if (!usernames.length) {
      // Belum ada mapping sama sekali -- langsung tampil semua toko, tidak perlu tanya apa-apa.
      applyMapping(null);
      return;
    }
    injectPickerMarkup(usernames);
  });
}

export function getCurrentMapping() {
  return cachedMapping;
}

// storeIsAllowed(storeId): true kalau tidak ada akun dipilih (= semua toko),
// akunnya master, atau tokonya ada di daftar storeIds akun itu.
export function storeIsAllowed(storeId) {
  if (!cachedMapping) return true;
  if (cachedMapping.isMaster) return true;
  return Array.isArray(cachedMapping.storeIds) && cachedMapping.storeIds.includes(storeId);
}

export function switchAccount() {
  localStorage.removeItem('sba_selected_account');
  window.location.reload();
}
