import { beforeEach, describe, expect, it } from "vitest";
import { clearPass, loadPass, savePass } from "../src/lib/passpaus";
import { Session } from "../src/lib/session";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData, Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "hola|interj", rank: 1, es: "hola", pos: "interj", sv: "hej", syn: [] },
  { id: "casa|n", rank: 2, es: "casa", pos: "n", sv: "hus", syn: [], art: "la" },
  { id: "perro|n", rank: 3, es: "perro", pos: "n", sv: "hund", syn: [], art: "el" },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  return store;
}

// enkel localStorage-stubb för nodmiljön
function stubStorage(): Record<string, string> {
  const bag: Record<string, string> = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => bag[k] ?? null,
    setItem: (k: string, v: string) => { bag[k] = v; },
    removeItem: (k: string) => { delete bag[k]; },
  };
  return bag;
}

describe("fortsätt avbruten övning", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); stubStorage(); });

  it("ögonblicksbild + återupptagning: kön, ordning, räknare och prognos följer med", () => {
    const fresh = store.introduceUnits(2);
    const s = new Session(store, fresh);
    const first = s.current!;
    s.answer("hej"); s.commit(); // ett kort klart (+ ev. syskonuppskov)
    const snap = s.snapshot();
    expect(snap.done).toBe(1);
    expect(snap.counts.good).toBe(1);

    const s2 = Session.restore(store, snap);
    expect(s2.done).toBe(1);
    expect(s2.counts.good).toBe(1);
    expect(s2.queue.map((c) => `${c.wordId}:${c.dir}`))
      .toEqual(snap.queue.map(([w, d]) => `${w}:${d}`));
    expect(s2.queue.some((c) => c.wordId === first.wordId && c.dir === first.dir)).toBe(false);
    expect(s2.snapshot().baseline).toBe(snap.baseline); // prognosen fortsätter räkna rätt
  });

  it("kort som hunnit ändras under pausen hoppar av kön", () => {
    const fresh = store.introduceUnits(2);
    const s = new Session(store, fresh);
    const snap = s.snapshot();
    // under pausen: casa ✓-markeras som Kan det → förfaller om 30 dagar
    store.setLevel("casa|n", "kan");
    const s2 = Session.restore(store, snap);
    expect(s2.queue.some((c) => c.wordId === "casa|n")).toBe(false);
    expect(s2.queue.some((c) => c.wordId === "hola|interj")).toBe(true);
  });

  it("sparning gäller bara samma dag — gårdagens pass rensas", () => {
    const s = new Session(store, store.introduceUnits(2));
    savePass(s.snapshot());
    expect(loadPass()?.queue.length).toBe(s.queue.length);
    // manipulera dagsstämpeln → ska förkastas och städas bort
    const bag = (globalThis as Record<string, unknown>).localStorage as { getItem(k: string): string | null; setItem(k: string, v: string): void };
    const raw = JSON.parse(bag.getItem("glosa.pass.v1")!);
    bag.setItem("glosa.pass.v1", JSON.stringify({ ...raw, day: "2020-01-01" }));
    expect(loadPass()).toBeNull();
    expect(bag.getItem("glosa.pass.v1")).toBeNull();
  });

  it("tom sparning och clearPass ger null", () => {
    clearPass();
    expect(loadPass()).toBeNull();
  });
});
