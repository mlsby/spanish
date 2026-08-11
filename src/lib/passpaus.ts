import type { SessionState } from "./session";
import { dayKey } from "./time";

/**
 * Pågående pass sparas lokalt på enheten (inte i molnsynken — ett halvfärdigt
 * pass hör till just den här skärmen) så en avbruten övning kan fortsättas.
 * Bara samma kalenderdag: imorgon är det ändå en ny övning.
 */
const KEY = "glosa.pass.v1";

interface Saved extends SessionState { v: 1; day: string }

export function savePass(state: SessionState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, day: dayKey(), ...state }));
  } catch { /* privat läge/fullt — passet går bara inte att återuppta */ }
}

export function loadPass(): SessionState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    if (s.v !== 1 || s.day !== dayKey() || !s.queue?.length) {
      localStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function clearPass(): void {
  try { localStorage.removeItem(KEY); } catch { /* ofarligt */ }
}
