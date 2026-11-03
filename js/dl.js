/* Unduh template dari aplikasi terpasang (PWA). Tautan download biasa membuka tab browser, dan unduhan blob
   sering diam saja di iPhone. Urutan: menu bagikan bawaan HP dengan file terlampir (pilih "Simpan ke Berkas"),
   lalu unduhan blob, lalu tautan biasa. File diambil lebih dulu supaya menu bagikan masih dalam sentuhan pengguna. */
(function () {
  var cache = {};
  var MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', json: 'application/json' };

  function say(msg) {
    var t = document.getElementById('dl-toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'dl-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);max-width:88vw;padding:10px 16px;border-radius:12px;background:rgba(20,24,40,.94);color:#fff;font:600 13px/1.4 system-ui,sans-serif;z-index:99999;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.35)';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 3500);
  }
  function nameOf(a) { return a.getAttribute('download') || decodeURIComponent(a.href.split('/').pop().split('?')[0]) || 'file'; }
  function load(url) {
    if (!cache[url]) cache[url] = fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.blob();
    }).catch(function (e) { delete cache[url]; throw e; });
    return cache[url];
  }
  function saveBlob(b, name) {
    var o = URL.createObjectURL(b), t = document.createElement('a');
    t.href = o; t.download = name; t.style.display = 'none';
    document.body.appendChild(t); t.click(); t.remove();
    setTimeout(function () { URL.revokeObjectURL(o); }, 4000);
  }
  function deliver(b, name, url) {
    var ext = name.split('.').pop().toLowerCase();
    var file;
    try { file = new File([b], name, { type: b.type || MIME[ext] || 'application/octet-stream' }); } catch (e) { file = null; }
    var touch = navigator.maxTouchPoints > 0 && window.matchMedia && matchMedia('(pointer:coarse)').matches;
    if (file && touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: name }).then(function () { return 'shared'; }).catch(function (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        saveBlob(b, name); return 'saved';
      });
    }
    saveBlob(b, name); return Promise.resolve('saved');
  }

  // Siapkan file template di latar belakang.
  window.addEventListener('load', function () {
    setTimeout(function () {
      Array.prototype.forEach.call(document.querySelectorAll('a[download]'), function (a) { load(a.href).catch(function () {}); });
    }, 800);
  });

  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('a[download]');
    if (!a || ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey) return;
    var url = a.href;
    if (!url || a.dataset.dlBusy) return;
    ev.preventDefault();
    a.dataset.dlBusy = '1';
    var name = nameOf(a);
    say('Menyiapkan ' + name + '...');
    load(url).then(function (b) { return deliver(b, name, url); }).then(function (r) {
      if (r === 'saved') say('Template diunduh: ' + name + '. Cek folder Unduhan atau Berkas.');
      else if (r === 'shared') say('Pilih "Simpan ke Berkas" atau aplikasi tujuan.');
    }).catch(function () {
      say('Gagal mengunduh. Coba buka tautan lewat browser.');
      window.location.href = url;
    }).then(function () { delete a.dataset.dlBusy; });
  });
})();
