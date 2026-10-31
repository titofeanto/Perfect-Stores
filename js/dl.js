/* Unduh template langsung dari aplikasi terpasang (PWA): tautan download biasa malah membuka tab browser.
   Ambil file lewat fetch, lalu simpan sebagai blob. Kalau gagal, kembali ke tautan biasa. */
document.addEventListener('click', function (ev) {
  var a = ev.target.closest && ev.target.closest('a[download]');
  if (!a || ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey) return;
  var url = a.href;
  if (!url || a.dataset.dlBusy) return;
  ev.preventDefault();
  a.dataset.dlBusy = '1';
  var name = a.getAttribute('download') || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'file';
  fetch(url, { cache: 'no-cache' }).then(function (r) {
    if (!r.ok) throw new Error('http ' + r.status);
    return r.blob();
  }).then(function (b) {
    var o = URL.createObjectURL(b), t = document.createElement('a');
    t.href = o; t.download = name; t.style.display = 'none';
    document.body.appendChild(t); t.click(); t.remove();
    setTimeout(function () { URL.revokeObjectURL(o); }, 4000);
  }).catch(function () {
    window.location.href = url;
  }).then(function () { delete a.dataset.dlBusy; });
});
