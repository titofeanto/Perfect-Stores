// Monday-Sunday calendar week helpers
export const MONTHS_ID = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
export const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];

export function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function fmtShort(d) {
  return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()];
}

// Returns Monday-Sunday weeks that overlap the given month (year, monthIndex0)
export function getWeeksForMonth(year, monthIndex0) {
  const firstOfMonth = new Date(year, monthIndex0, 1);
  const lastOfMonth = new Date(year, monthIndex0 + 1, 0);
  const dow = firstOfMonth.getDay(); // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7;
  let weekStart = addDays(firstOfMonth, -offsetToMonday);
  const weeks = [];
  let i = 1;
  while (weekStart <= lastOfMonth) {
    const weekEnd = addDays(weekStart, 6);
    weeks.push({
      label: 'Minggu ' + i,
      start: weekStart,
      end: weekEnd,
      periodKey: isoDate(weekStart)
    });
    weekStart = addDays(weekStart, 7);
    i++;
  }
  return weeks;
}

export function findWeekContaining(weeks, date) {
  return weeks.findIndex(w => date >= w.start && date <= w.end);
}
