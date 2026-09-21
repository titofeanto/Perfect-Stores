// Navigasi pindah halaman di BAWAH layar (bottom nav, seperti aplikasi HP): Input, Survei Harga,
// Dashboard, Akun. Dipasang otomatis di semua halaman; halaman yang sedang dibuka ditandai.
// Styling ada di css/style.css (.bottom-nav). Tidak bergantung Firebase, jadi tampil segera.

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

function currentPage() {
  const last = location.pathname.split('/').pop();
  return last || 'index.html';
}

function mount() {
  if (document.getElementById('bottomNav')) return;
  const page = currentPage();
  const nav = document.createElement('nav');
  nav.id = 'bottomNav';
  nav.className = 'bottom-nav';
  nav.setAttribute('aria-label', 'Navigasi halaman');
  nav.innerHTML = '<div class="bottom-nav-inner">' + ITEMS.map(it => {
    const active = it.href === page;
    return `<a href="${it.href}" class="bottom-nav-item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>`
      + `<span class="bottom-nav-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[it.icon]}</svg></span>`
      + `<span class="bottom-nav-label">${it.label}</span></a>`;
  }).join('') + '</div>';
  document.body.appendChild(nav);
  document.body.classList.add('has-bottom-nav');
}

if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount);
