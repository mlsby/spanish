import { dayKey } from "./time";

/**
 * Streak & totala övningsdagar ur dagskartan (dagKey -> antal besvarade kort).
 * Streaken är stenhård: missad dag nollar — men dagens pass räknas som
 * "inte missat än" fram till midnatt, så streaken lever tills dagen är slut.
 */
export function activityStats(
  days: Record<string, number>,
  now: Date = new Date()
): { streak: number; totalDays: number } {
  let totalDays = 0;
  for (const k in days) {
    if (days[k] > 0) totalDays++;
  }
  const d = new Date(now);
  if (!(days[dayKey(d)] > 0)) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (days[dayKey(d)] > 0) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return { streak, totalDays };
}
