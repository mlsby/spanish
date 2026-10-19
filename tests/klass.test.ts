import { describe, expect, it } from "vitest";
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
    expect(store.portionsPlan().totalKort).toBe(6);
    store.setLage("klass");
    expect(store.portionsPlan().totalKort).toBe(2); // casa åt båda hållen
    expect(store.nextIntroUnits(5)).toEqual([]);
    store.setLage("allt");
    expect(store.portionsPlan().totalKort).toBe(6); // korten utanför vilade bara
  });
});
