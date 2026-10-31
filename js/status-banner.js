/* Pemberitahuan perbaikan/maintenance. Dibaca dari Apps Script (?view=status), diubah lewat admin-status.html di Monitoring Daily. Cadangan: status.json.
   aktif=true: spanduk di atas layar. blokir=true: layar penuh, aplikasi tidak bisa dipakai.
   Skrip ini sengaja bukan module dan berdiri sendiri, supaya tetap jalan walaupun app.js gagal dimuat. */
(function () {
  var me = document.currentScript;
  var ep = (me && me.getAttribute('data-endpoint')) || (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL) || '';
  var fb = me && me.getAttribute('data-fallback');
  var shown = null;
  function css() {
    if (document.getElementById('sb-css')) return;
    var s = document.createElement('style'); s.id = 'sb-css';
    s.textContent = '#sb-bar{position:fixed;left:0;right:0;top:0;z-index:99998;padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px;background:#FFF3C4;color:#5A4300;font:600 13px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.15)}' +
      '#sb-full{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:24px;background:rgba(20,16,50,.92);color:#fff;font:500 15px/1.5 system-ui,sans-serif;text-align:center}' +
      '#sb-full div{max-width:420px}#sb-full h2{margin:0 0 10px;font-size:20px}#sb-full button{margin-top:16px;border:0;border-radius:999px;padding:11px 22px;font:700 14px system-ui;background:#fff;color:#3E24C9}';
    document.head.appendChild(s);
  }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function show(kind, judul, pesan, canReload) {
    if (shown === kind + pesan) return; shown = kind + pesan;
    css();
    ['sb-bar', 'sb-full'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); });
    var el = document.createElement('div');
    if (kind === 'bar') { el.id = 'sb-bar'; el.innerHTML = '<b>' + esc(judul) + '</b> ' + esc(pesan); }
    else { el.id = 'sb-full'; el.innerHTML = '<div><h2>' + esc(judul) + '</h2><p>' + esc(pesan) + '</p>' + (canReload ? '<button type="button" id="sb-reload">Muat ulang</button>' : '') + '</div>'; }
    (document.body || document.documentElement).appendChild(el);
    var b = document.getElementById('sb-reload'); if (b) b.onclick = function () { location.reload(); };
  }
  /* Dipanggil dari atribut onerror skrip utama dan dari penjaga waktu di bawah. */
  window.__appFail = function () {
    show('full', 'Aplikasi belum bisa dibuka', 'Aplikasi gagal dimuat, kemungkinan sedang diperbaiki. Data Anda aman. Coba muat ulang beberapa menit lagi. Kalau tetap sama, hubungi admin.', true);
  };
  /* Sumber utama: Apps Script (?view=status, diubah lewat admin-status.html). Cadangan: file status.json kalau diisi di data-fallback. */
  function ambil() {
    var viaGas = ep ? fetch(ep + (ep.indexOf('?') < 0 ? '?' : '&') + 'view=status&t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(function (j) { if (j && j.mode === 'status') return j; throw new Error('bukan status'); }) : Promise.reject(new Error('tanpa endpoint'));
    return viaGas.catch(function () {
      if (!fb) throw new Error('tidak ada sumber');
      return fetch(fb + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); });
    });
  }
  function cek() {
    ambil().then(function (j) {
      if (!j || !j.aktif) { shown = null; ['sb-bar', 'sb-full'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); }); return; }
      show(j.blokir ? 'full' : 'bar', j.judul || 'Pemberitahuan', j.pesan || (j.blokir ? 'Aplikasi sedang diperbaiki.' : ''), !!j.blokir);
    }).catch(function () { /* offline: biarkan keadaan terakhir */ });
  }
  cek();
  setInterval(cek, 300000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) cek(); });
  if (document.documentElement.hasAttribute('data-watch')) {
    setTimeout(function () { if (!window.__appReady && navigator.onLine !== false) window.__appFail(); }, 15000);
  }
})();
