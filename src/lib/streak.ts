import { dayKey } from "./time";

/**
 * Streak & totala övningsdagar ur dagskartan (dagKey -> antal besvarade kort).
 * Streaken är stenhård: missad dag nollar — men dagens pass räknas som
 * "inte missat än" fram till midnatt, så streaken lever tills dagen är slut.
 */
/** Rätta svar som krävs för att en dag ska räknas i streaken (från REGEL_FRAN). */
export const STREAK_MAL = 20;
/** Dagar före detta datum räknas som förut: ett enda besvarat kort räckte. */
const REGEL_FRAN = "2026-10-20";

/** Räknas dagen i streaken? Med `ratt` gäller 20-rätt-regeln från REGEL_FRAN. */
export function dagRaknas(
  day: string, days: Record<string, number>, ratt?: Record<string, number>,
): boolean {
  if (ratt && day >= REGEL_FRAN) return (ratt[day] ?? 0) >= STREAK_MAL;
  return (days[day] ?? 0) > 0;
}

export function activityStats(
  days: Record<string, number>,
  now: Date = new Date(),
  ratt?: Record<string, number>,
): { streak: number; totalDays: number } {
  let totalDays = 0;
  for (const k in days) {
    if (days[k] > 0) totalDays++;
  }
  const d = new Date(now);
  if (!dagRaknas(dayKey(d), days, ratt)) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (dagRaknas(dayKey(d), days, ratt)) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return { streak, totalDays };
}
