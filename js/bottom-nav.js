// Navigasi pindah halaman di BAWAH layar: kapsul kaca mengambang (Liquid Glass) berisi Input,
// Survei Harga, Dashboard, Akun. Dipasang otomatis di semua halaman; halaman aktif ditandai lensa kaca.
// Styling ada di css/style.css (.bottom-nav). Tidak bergantung Firebase, jadi tampil segera.
//
// Antar halaman adalah pindah halaman penuh (bukan SPA), jadi lensa tidak bisa "hidup terus".
// Triknya: halaman sebelumnya menyimpan posisi tab aktifnya di sessionStorage; di halaman baru lensa
// dimulai dari posisi itu lalu meluncur ke tab yang benar dengan pegas. Klik tidak ditunda sedikit pun --
// pindah halaman langsung, animasinya menyusul.

const ICONS = {
  input: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><path d="M9 12h6M9 16h4"/>',
  harga: '<path d="M3 12.5V4.5a1.5 1.5 0 0 1 1.5-1.5h8L21 11.5a2 2 0 0 1 0 2.8l-6.2 6.2a2 2 0 0 1-2.8 0z"/><circle cx="8" cy="8" r="1.3"/>',
  dashboard: '<path d="M4 20V11M10 20V4M16 20v-6M3 20h18"/>',
  akun: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6a6.5 6.5 0 0 1 3.5 5.4"/>',
};

const ITEMS = [
  { href: 'index.html', label: 'Input', icon: 'input' },
  { href: 'harga.html', label: 'Survei Harga', icon: 'harga' },
  { href: 'dashboard.html', label: 'Dashboard', icon: 'dashboard' },
  { href: 'mapping.html', label: 'Akun', icon: 'akun' },
];

const STORE_KEY = 'bnav_prev_index';

function currentPage() {
  const last = location.pathname.split('/').pop();
  return last || 'index.html';
}

// Ketukan tab tidak membawa momentum -> hampir kritis (damping 0.92, tanpa pantulan terlihat),
// response 0.32s, dipotong di 1.4x response (~450ms; sisa <0.1% tak terlihat).
// Dijadikan easing CSS linear(): lensa dianimasikan dari nilai SAAT INI ke target, bukan durasi kaku.
function springEasing(damping = 0.92, response = 0.32) {
  const w = (2 * Math.PI) / response;
  const wd = w * Math.sqrt(1 - damping * damping);
  const T = response * 1.4;
  const pts = [];
  const N = 28;
  for (let k = 0; k <= N; k++) {
    const t = (k / N) * T;
    const x = 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t));
    pts.push((k === N ? 1 : x).toFixed(4));
  }
  return { easing: `linear(${pts.join(', ')})`, duration: Math.round(T * 1000) };
}

// linear() baru ada di Safari 17.2+. Di bawahnya pakai ease-out kuat 320ms (bukan error).
function lensTiming() {
  const ok = window.CSS && CSS.supports && CSS.supports('animation-timing-function', 'linear(0, 1)');
  return ok ? springEasing() : { easing: 'cubic-bezier(0.22, 1, 0.36, 1)', duration: 320 };
}

function safeStorage(fn) {
  try { return fn(); } catch (e) { return null; }
}

function mount() {
  if (document.getElementById('bottomNav')) return;
  const page = currentPage();
  const activeIdx = Math.max(0, ITEMS.findIndex(it => it.href === page));
  const nav = document.createElement('nav');
  nav.id = 'bottomNav';
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'Navigasi halaman');
  nav.innerHTML = '<div class="bottom-nav-inner"><span class="bottom-nav-lens" aria-hidden="true"></span>'
    + ITEMS.map((it, i) => {
      const active = i === activeIdx;
      return `<a href="${it.href}" class="bottom-nav-item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>`
        + `<span class="bottom-nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[it.icon]}</svg></span>`
        + `<span class="bottom-nav-label">${it.label}</span></a>`;
    }).join('') + '</div>';
  const inner = nav.firstChild;
  inner.style.setProperty('--n', ITEMS.length);
  inner.style.setProperty('--i', activeIdx);
  document.body.appendChild(nav);
  document.body.classList.add('has-bottom-nav');

  // Lensa meluncur dari tab halaman sebelumnya ke tab halaman ini
  const lens = inner.querySelector('.bottom-nav-lens');
  const items = [...inner.querySelectorAll('.bottom-nav-item')];
  const prev = safeStorage(() => sessionStorage.getItem(STORE_KEY));
  const prevIdx = prev === null ? NaN : Number(prev);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = !reduce && lens.animate && Number.isInteger(prevIdx)
    && prevIdx >= 0 && prevIdx < ITEMS.length && prevIdx !== activeIdx;
  // Simpan DULU: kalau animasi gagal, halaman berikutnya tetap benar.
  safeStorage(() => sessionStorage.setItem(STORE_KEY, String(activeIdx)));
  if (canAnimate) {
    try {
      const s = lensTiming();
      // Warna label ikut bergerak bersama lensa: mulai dari tab lama, pindah ke tab baru di frame berikutnya
      // (aria-current tetap di tab yang benar sejak awal).
      items[activeIdx].classList.remove('active');
      items[prevIdx].classList.add('active');
      lens.animate(
        [{ transform: `translateX(${prevIdx * 100}%)` }, { transform: `translateX(${activeIdx * 100}%)` }],
        { duration: s.duration, easing: s.easing }
      );
      requestAnimationFrame(() => requestAnimationFrame(() => {
        items[prevIdx].classList.remove('active');
        items[activeIdx].classList.add('active');
      }));
    } catch (e) {
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    }
  }
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount);
