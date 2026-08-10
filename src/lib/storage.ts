import type { AppData, Settings } from "./types";

/**
 * Lagringsabstraktion. v1 använder localStorage; när Supabase kopplas på
 * implementeras samma gränssnitt mot molnet (+ migrering via export/import).
 */
export interface StorageAdapter {
  load(): AppData | null;
  save(data: AppData): void;
}

export function emptyData(): AppData {
  return {
    version: 1,
    settings: { newFirst: 10, newMore: 5 },
    userWords: {},
    cards: {},
    reviews: [],
    introduced: {},
    days: {},
    snapshots: {},
  };
}

/** Äldre sparfiler har `newPerDay` — den blir första övningens takt. */
function normSettings(s: Partial<Settings> & { newPerDay?: number } = {}): Settings {
  return {
    newFirst: s.newFirst ?? s.newPerDay ?? 10,
    newMore: s.newMore ?? 5,
    updatedAt: s.updatedAt,
  };
}

const KEY = "glosa.v1";

export class LocalStorageAdapter implements StorageAdapter {
  load(): AppData | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as AppData;
      if (d.version !== 1) return null;
      return { ...emptyData(), ...d, settings: normSettings(d.settings) };
    } catch {
      return null;
    }
  }
  save(data: AppData): void {
    localStorage.setItem(KEY, JSON.stringify(data));
  }
}

/** Be webbläsaren om beständig lagring (minskar risken att iOS/Chrome städar bort datat). */
export function requestPersistence(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* stöds inte överallt — ofarligt */
  }
}

export function exportBlob(data: AppData): Blob {
  return new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
}

export function parseImport(text: string): AppData {
  const d = JSON.parse(text) as AppData;
  if (!d || d.version !== 1 || typeof d.cards !== "object") {
    throw new Error("Filen ser inte ut som en Glosa-backup (version 1).");
  }
  return { ...emptyData(), ...d, settings: normSettings(d.settings) };
}
