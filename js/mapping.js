import { authReady } from './firebase-init.js';
import { pickAccount, switchAccount } from './store-filter.js?v=1';
import { loadStores } from './store-data.js';

const el = (id) => document.getElementById(id);
let stores = [];
let pendingMapping = null;

async function init() {
  await authReady;
  await pickAccount(); // cuma dipakai konsisten dgn halaman lain; tidak membatasi akses ke halaman ini
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', switchAccount);

  stores = await loadStores();

  el('mappingFileInput').addEventListener('change', onFileSelected);
  el('mappingDownloadBtn').addEventListener('click', onDownloadClick);
}

// Kolom "Store Name" formatnya "{StoreID}-{Nama Toko}" -- ID-nya dicocokkan dulu
// (paling akurat), nama cuma fallback kalau formatnya beda dari yang diharapkan.
function parseStoreCell(raw) {
  const val = String(raw).trim();
  const m = val.match(/^((?:\d+-)*\d+)-(.+)$/);
  if (m) return { id: m[1], name: m[2].trim() };
  return { id: null, name: val };
}

function findStore(storeCellValue) {
  const { id, name } = parseStoreCell(storeCellValue);
  if (id) {
    const byId = stores.find(s => s.id === id);
    if (byId) return byId;
  }
  const n = name.trim().toLowerCase();
  return stores.find(s => s.name.trim().toLowerCase() === n) || null;
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  el('mappingParsePreview').textContent = 'Membaca file...';
  el('mappingParseDetail').innerHTML = '';
  el('mappingDownloadBtn').disabled = true;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const wb = window.XLSX.read(ev.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      if (!rows.length) { el('mappingParsePreview').textContent = 'File kosong.'; return; }
      const header = rows[0].map(h => (h == null ? '' : String(h).trim().toLowerCase()));
      const idx = {
        username: header.indexOf('username'),
        nama: header.indexOf('nama'),
        toko: header.indexOf('store name'),
        scope: header.indexOf('scope channel'),
      };
      if (idx.username === -1 || idx.toko === -1) {
        el('mappingParsePreview').textContent = 'Format tidak dikenali. Pastikan ada kolom Username dan Store Name.';
        return;
      }

      const byUsername = {};
      const unknownStores = [];
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row[idx.username] == null) continue;
        const username = String(row[idx.username]).trim();
        if (!username) continue;
        const name = idx.nama !== -1 && row[idx.nama] != null ? String(row[idx.nama]).trim() : username;
        const tokoRaw = row[idx.toko] != null ? String(row[idx.toko]).trim() : '';
        const scope = idx.scope !== -1 && row[idx.scope] != null ? String(row[idx.scope]).trim() : '';

        if (!byUsername[username]) byUsername[username] = { name, storeIds: [], isMaster: false };
        if (!tokoRaw) continue;
        if (/^semua$|^all$/i.test(tokoRaw)) {
          byUsername[username].isMaster = true;
          continue;
        }
        const store = findStore(tokoRaw);
        if (store) {
          if (!byUsername[username].storeIds.includes(store.id)) byUsername[username].storeIds.push(store.id);
        } else {
          const { id, name: n } = parseStoreCell(tokoRaw);
          unknownStores.push({ username, id: id || '(tanpa ID)', name: n, scope });
        }
      }

      pendingMapping = byUsername;
      const usernameCount = Object.keys(byUsername).length;
      el('mappingParsePreview').textContent = `${usernameCount} akun terbaca (dari ${rows.length - 1} baris), siap di-download.`;
      let detail = '';
      if (unknownStores.length) {
        detail += `<p class="upload-status" style="color:var(--danger);">${unknownStores.length} baris menyebut toko yang BELUM ADA di data app ini -- baris ini TIDAK ikut dimasukkan:</p>`;
        detail += unknownStores.slice(0, 15).map(u => `<p class="upload-status">- ${u.username}: ${u.name} (ID ${u.id}${u.scope ? ', scope ' + u.scope : ''})</p>`).join('');
        if (unknownStores.length > 15) detail += `<p class="upload-status">...dan ${unknownStores.length - 15} lainnya.</p>`;
      }
      el('mappingParseDetail').innerHTML = detail;
      el('mappingDownloadBtn').disabled = usernameCount === 0;
    } catch (err) {
      console.error(err);
      el('mappingParsePreview').textContent = 'Gagal membaca file.';
    }
  };
  reader.readAsArrayBuffer(file);
}

function onDownloadClick() {
  if (!pendingMapping) return;
  const blob = new Blob([JSON.stringify(pendingMapping, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'user-mapping.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('user-mapping.json ter-download. Upload file ini ke folder data/ di GitHub (timpa yang lama).', 'success');
}

let toastTimer;
function showToast(message, type) {
  const t = el('toast');
  t.textContent = message;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 4500);
}

init();
