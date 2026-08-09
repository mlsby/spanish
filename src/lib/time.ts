/** Lokal dagnyckel: "2026-08-09" */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function endOfToday(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Måndagsindex 0–6 (sv vecka börjar på måndag). */
export function weekdayMon(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function fmtDate(d: Date = new Date()): string {
  return d.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
}
