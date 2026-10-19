import { describe, expect, it } from "vitest";
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
  { id: "poder|v", rank: 1, es: "poder", pos: "v", sv: "kunna", syn: [] },
  { id: "casa|n", rank: 2, es: "casa", pos: "n", sv: "hus", syn: [], art: "la" },
  { id: "querer|v", rank: 3, es: "querer", pos: "v", sv: "vilja", syn: [] },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  store.klassOrd = new Set(["casa|n"]);
  return store;
}

describe("klassläget", () => {
  it("övar bara klassens ord och tar inga nya ur frekvenskön", () => {
    const store = makeStore();
    store.introduceUnits(3);
    expect(store.portionsPlan().totalKort).toBe(3); // ett håll per ord och dag
    store.setLage("klass");
    expect(store.portionsPlan().totalKort).toBe(1); // bara casa
    expect(store.nextIntroUnits(5)).toEqual([]);
    store.setLage("allt");
    expect(store.portionsPlan().totalKort).toBe(3); // korten utanför vilade bara
  });
});

describe("bokens svenska", () => {
  it("visas i klassläget och godkänns i båda lägena", () => {
    const store = makeStore();
    store.klassSv = new Map([["casa|n", "bostad"]]);
    store.introduceUnits(3);
    const kort = store.card("casa|n", "es2sv")!;
    expect(store.wordFor(kort).sv).toBe("hus");
    expect(store.targetsFor(kort)).toContain("bostad");
    store.setLage("klass");
    expect(store.wordFor(kort).sv).toBe("bostad");
    expect(store.targetsFor(kort)).toContain("hus");
  });
});

describe("ett rätt är ett rätt", () => {
  it("ett ord som övats åt ett håll idag frågas inte åt det andra samma dag", () => {
    const store = makeStore();
    const now = new Date();
    store.introduceUnits(1, now); // poder: båda korten
    const forsta = store.startPortion(now);
    expect(forsta.map((c) => c.dir)).toEqual(["es2sv"]);
    const s = new Session(store, forsta);
    s.answer("kunna"); s.commit(now);
    expect(store.portionsPlan(now).unseen.some((c) => c.wordId === "poder|v")).toBe(false);
    // andra hållet finns kvar obesvarat och kommer en annan dag
    expect(store.card("poder|v", "sv2es")!.fsrs.reps).toBe(0);
  });
});

