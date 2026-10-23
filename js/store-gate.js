// Layar pilih toko: Area -> Toko -> Konfirmasi, supaya SBA tidak salah toko saat mengisi data.
// Dipakai halaman Input dan Survei Harga. Daftar <select> lama tetap ada (disembunyikan) karena logika halaman
// membacanya; layar ini hanya memilihkan toko lalu memanggil onPick(store).
//
// Aturan:
//  - Pertama kali membuka halaman dalam satu sesi tab: layar ini muncul dulu (toko terakhir ditawarkan di atas).
//  - Refresh halaman di sesi yang sama: langsung masuk ke toko yang sudah dikonfirmasi tadi.
//  - Dibuka dari link dashboard (?store=...): langsung ke toko itu, tanpa layar.
//  - Di dalam halaman, bar "Toko aktif" menempel di atas dan tombol "Ganti" membuka layar yang sama.

const SS = k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
const SS_SET = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* mode privat */ } };
const LS = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const LS_SET = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* mode privat */ } };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  swap: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
};
const svg = (k, cls) => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${ICON[k]}</svg>`;

export function setupStoreGate({ pageKey, stores, channelLabel, onPick }) {
  const KEY_LAST = 'sba_last_store';
  const KEY_OK = 'sba_gate_ok_' + pageKey;
  let active = null;
  let step = 'area';     // 'area' | 'store'
  let area = '';
  let channel = 'all';
  let query = '';
  let pending = null;    // toko yang sedang dikonfirmasi
  let canCancel = false;

  const byId = id => stores.find(s => s.id === id) || null;
  const areas = () => [...new Set(stores.map(s => s.area))].sort((a, b) => a.localeCompare(b, 'id'));
  const chLabel = s => channelLabel(s.scopeSlug);

  /* ---------- bar "Toko aktif" ---------- */
  const bar = document.createElement('div');
  bar.id = 'activeStore';
  bar.className = 'active-store';
  bar.hidden = true;
  const header = document.querySelector('header.appbar');
  if (header) header.insertAdjacentElement('afterend', bar); else document.querySelector('.app').prepend(bar);
  bar.addEventListener('click', e => { if (e.target.closest('[data-change]')) open(); });

  function renderBar() {
    if (!active) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<span class="as-ico">${svg('pin')}</span>` +
      `<div class="as-txt"><small>Toko aktif</small><b>${esc(active.name)}</b><span>${esc(active.area)} &middot; ${esc(chLabel(active))}${active.subChannel ? ' &middot; ' + esc(active.subChannel) : ''}</span></div>` +
      `<button type="button" class="as-btn" data-change>${svg('swap')}Ganti</button>`;
  }

  /* ---------- layar pilih ---------- */
  const gate = document.createElement('div');
  gate.id = 'storeGate';
  gate.className = 'store-gate';
  gate.hidden = true;
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-label', 'Pilih toko');
  document.body.appendChild(gate);

  function head(title, sub) {
    return `<div class="gate-top"><span class="brand-mark" aria-hidden="true">${svg('pin')}</span><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div></div>`;
  }
  const storeCard = s => `<button type="button" class="store-card" data-pick="${esc(s.id)}"><span class="sc-name">${esc(s.name)}</span>` +
    `<span class="sc-meta"><span class="ch-pill ch-${esc(s.scopeSlug)}">${esc(chLabel(s))}</span><span>${esc(s.area)}</span></span><span class="sc-go">${svg('chev')}</span></button>`;

  function matches(q, list) {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return list.filter(s => (s.name + ' ' + s.area).toLowerCase().includes(t)).sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }

  function render() {
    const last = byId(LS(KEY_LAST));
    let html = '';
    if (step === 'area') {
      html += head('Pilih toko', 'Pastikan toko yang Anda isi sudah benar.');
      if (canCancel && active) html += `<button type="button" class="gate-cancel" data-cancel>${svg('x')}Batal, tetap di ${esc(active.name)}</button>`;
      if (last && !(active && active.id === last.id && canCancel)) {
        html += `<button type="button" class="gate-last" data-pick="${esc(last.id)}"><small>Lanjutkan toko terakhir</small><b>${esc(last.name)}</b><span>${esc(last.area)} &middot; ${esc(chLabel(last))}</span><i>${svg('chev')}</i></button>`;
      }
      html += `<label class="field-label" for="gateSearch">Cari nama toko (semua area)</label>` +
        `<label class="sbox">${svg('search')}<input id="gateSearch" type="search" placeholder="Ketik nama toko" autocomplete="off" value="${esc(query)}"></label>` +
        `<div id="gateResults" class="store-list"></div>` +
        `<div class="gate-sec" id="gateAreaTitle">Atau pilih area</div>` +
        `<div class="area-grid" id="gateAreas">${areas().map(a => {
          const list = stores.filter(s => s.area === a);
          return `<button type="button" class="area-card" data-area="${esc(a)}"><b>${esc(a)}</b><span>${list.length} toko</span></button>`;
        }).join('')}</div>`;
    } else {
      const inArea = stores.filter(s => s.area === area);
      const slugs = [...new Set(inArea.map(s => s.scopeSlug))];
      const base = channel === 'all' ? inArea : inArea.filter(s => s.scopeSlug === channel);
      const q = query.trim().toLowerCase();
      const list = (q ? base.filter(s => s.name.toLowerCase().includes(q)) : base).sort((a, b) => a.name.localeCompare(b.name, 'id'));
      html += `<div class="gate-nav"><button type="button" class="gate-back" data-back>${svg('back')}Area</button><span>Langkah 2 dari 2</span></div>`;
      html += head(area, `${inArea.length} toko. Ketuk nama toko Anda.`);
      if (slugs.length > 1) {
        html += `<div class="chip-row gate-chips">` +
          [['all', 'Semua', inArea.length]].concat(slugs.map(sl => [sl, channelLabel(sl), inArea.filter(s => s.scopeSlug === sl).length]))
            .map(c => `<button type="button" class="chip${channel === c[0] ? ' active' : ''}" data-ch="${esc(c[0])}">${esc(c[1])} (${c[2]})</button>`).join('') + `</div>`;
      }
      html += `<label class="sbox">${svg('search')}<input id="gateSearch" type="search" placeholder="Cari di ${esc(area)}" autocomplete="off" value="${esc(query)}"></label>`;
      html += `<div class="gate-count">${list.length === inArea.length ? list.length + ' toko' : list.length + ' dari ' + inArea.length + ' toko'}</div>`;
      html += `<div class="store-list" id="gateList">${list.length ? list.map(storeCard).join('') : '<div class="gate-empty">Tidak ada toko yang cocok.</div>'}</div>`;
    }
    gate.innerHTML = `<div class="gate-scroll">${html}</div>` + confirmHtml();
    const input = gate.querySelector('#gateSearch');
    if (input) {
      input.addEventListener('input', onSearch);
      if (step === 'area' && query) renderResults();
    }
  }

  function confirmHtml() {
    if (!pending) return '';
    return `<div class="gate-confirm" data-confirm-bg><div class="sheet" role="alertdialog" aria-label="Konfirmasi toko">` +
      `<span class="si-big">${svg('pin')}</span><small>Toko yang akan Anda isi</small><h2>${esc(pending.name)}</h2>` +
      `<p class="sh-meta"><span class="ch-pill ch-${esc(pending.scopeSlug)}">${esc(chLabel(pending))}</span><span>${esc(pending.area)}</span></p>` +
      `<p class="sh-note">Periksa lagi nama toko dan areanya. Data yang Anda isi akan tersimpan atas nama toko ini.</p>` +
      `<button type="button" class="primary" data-yes>${svg('check')}Ya, buka toko ini</button>` +
      `<button type="button" data-no>Pilih lagi</button></div></div>`;
  }

  function renderResults() {
    const box = gate.querySelector('#gateResults'); if (!box) return;
    const res = matches(query, stores);
    const title = gate.querySelector('#gateAreaTitle'), grid = gate.querySelector('#gateAreas');
    const searching = !!query.trim();
    if (title) title.hidden = searching;
    if (grid) grid.hidden = searching;
    box.innerHTML = !searching ? '' : res.length
      ? res.slice(0, 30).map(storeCard).join('') + (res.length > 30 ? `<div class="gate-empty">+${res.length - 30} toko lain, persempit pencarian.</div>` : '')
      : '<div class="gate-empty">Toko tidak ditemukan. Coba kata lain, atau pilih lewat area.</div>';
  }

  function onSearch(e) {
    query = e.target.value;
    if (step === 'area') { renderResults(); return; }
    const pos = e.target.selectionStart;
    render();
    const inp = gate.querySelector('#gateSearch'); if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (err) { /* abaikan */ } }
  }

  gate.addEventListener('click', e => {
    const t = e.target;
    const pick = t.closest('[data-pick]');
    if (pick) { pending = byId(pick.dataset.pick); render(); return; }
    const a = t.closest('[data-area]');
    if (a) { area = a.dataset.area; step = 'store'; channel = 'all'; query = ''; render(); gate.querySelector('.gate-scroll').scrollTop = 0; return; }
    if (t.closest('[data-back]')) { step = 'area'; query = ''; render(); return; }
    const ch = t.closest('[data-ch]');
    if (ch) { channel = ch.dataset.ch; render(); return; }
    if (t.closest('[data-cancel]')) { close(); return; }
    if (t.closest('[data-no]')) { pending = null; render(); return; }
    if (t.closest('[data-yes]')) { confirm(); return; }
    if (t.matches('[data-confirm-bg]')) { pending = null; render(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || gate.hidden) return;
    if (pending) { pending = null; render(); } else if (canCancel) close();
  });

  async function confirm() {
    const s = pending; pending = null;
    if (!s) return;
    await choose(s);
    close();
  }

  async function choose(s) {
    active = s;
    LS_SET(KEY_LAST, s.id);
    SS_SET(KEY_OK, s.id);
    renderBar();
    await onPick(s);
  }

  function open() {
    canCancel = !!active;
    step = 'area'; area = ''; channel = 'all'; query = ''; pending = null;
    gate.hidden = false;
    document.body.classList.add('gate-open');
    render();
  }
  function close() {
    gate.hidden = true;
    document.body.classList.remove('gate-open');
  }

  return {
    open,
    /** Toko yang sudah dikonfirmasi di sesi tab ini (untuk refresh), atau null. */
    resume() { return byId(SS(KEY_OK)); },
    /** Tandai toko aktif tanpa layar (mis. dibuka dari link dashboard). */
    async setActive(s) { await choose(s); },
    /** Catat toko aktif tanpa memanggil onPick (halaman sudah memuatnya sendiri). */
    remember(s) { active = s; LS_SET(KEY_LAST, s.id); SS_SET(KEY_OK, s.id); renderBar(); },
  };
}
