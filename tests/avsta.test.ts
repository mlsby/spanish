import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/lib/session";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import { mergeCloudIntoLocal } from "../src/lib/sync";
import type { AppData, VerbForm, Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "poder|v", rank: 1, es: "poder", pos: "v", sv: "kunna", syn: [] },
  { id: "casa|n", rank: 2, es: "casa", pos: "n", sv: "hus", syn: [], art: "la" },
  { id: "querer|v", rank: 3, es: "querer", pos: "v", sv: "vilja", syn: [] },
  { id: "perro|n", rank: 4, es: "perro", pos: "n", sv: "hund", syn: [], art: "el" },
];

const FORMS: VerbForm[] = [
  { id: "poder|v#pres.1s", parent: "poder|v", es: "puedo", person: "1s", svPres: "kan", r: 65, slot: 1 },
  { id: "poder|v#pres.3s", parent: "poder|v", es: "puede", person: "3s", svPres: "kan", r: 83, slot: 2 },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.forms = FORMS.map((f) => ({ ...f }));
  store.formById = new Map(store.forms.map((f) => [f.id, f]));
  store.formsByParent = new Map();
  for (const f of store.forms) {
    if (!store.formsByParent.has(f.parent)) store.formsByParent.set(f.parent, []);
    store.formsByParent.get(f.parent)!.push(f);
  }
  store.data = emptyData();
  return store;
}

function klara(store: Store, id: string): void {
  const s = new Session(store, [store.card(id, "es2sv")!]);
  s.answer(store.byId.get(id)!.sv);
  s.commit();
}

describe("avstådda ord", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("introduceras aldrig — kön går vidare till nästa ord", () => {
    store.setAvstadd("poder|v", true);
    const units = store.nextIntroUnits(2);
    expect(units.map((u) => (u.kind === "word" ? u.word.id : ""))).toEqual(["casa|n", "querer|v"]);
  });

  it("försvinner ur portionen och blockerar inte glosorKlara", () => {
    store.introduceUnits(4);
    for (const w of WORDS) store.setAvstadd(w.id, true);
    const plan = store.portionsPlan();
    expect(plan.totalKort).toBe(0);
    expect(store.glosorKlara()).toBe(true); // enda "skulden" är avstådd
  });

  it("böjningar ärver moderverbets avstående — puedo introduceras inte", () => {
    store.introduceUnits(1); // poder
    klara(store, "poder|v"); // låser upp formerna (+ ev. återbäring)
    store.setAvstadd("poder|v", true);
    expect(store.avstadd("poder|v#pres.3s")).toBe(true);
    const units = store.nextIntroUnits(10);
    expect(units.some((u) => u.kind === "form")).toBe(false);
  });

  it("räknas bort ur statistiken — poäng, total och mål", () => {
    store.introduceUnits(2); // poder + casa
    klara(store, "poder|v");
    const fore = store.stats();
    expect(fore.score).toBeGreaterThan(0);
    store.setAvstadd("poder|v", true);
    const efter = store.stats();
    expect(efter.score).toBe(fore.score - 1);      // poder lämnar poängen
    expect(efter.total).toBe(WORDS.length + FORMS.length - 3); // ordet + två ärvda former
  });

  it("session.avsta: moderverbets och böjningens kort lämnar kön utan betyg", () => {
    store.introduceUnits(4);
    klara(store, "poder|v"); // puedo introduceras via återbäringen
    const cards = [store.card("poder|v", "sv2es")!, store.card("poder|v#pres.1s", "es2sv")!];
    const s = new Session(store, cards);
    expect(s.current!.wordId).toBe("poder|v");
    const reviews = store.data.reviews.length;
    s.avsta();
    expect(s.finished).toBe(true); // båda korten borta — böjningen följde moderverbet
    expect(store.avstadd("poder|v")).toBe(true);
    expect(store.data.reviews.length).toBe(reviews); // inget loggat
  });

  it("session.avsta på ett formkort tar bara formen — moderverbet övas vidare", () => {
    store.introduceUnits(4);
    klara(store, "poder|v");
    const s = new Session(store, [store.card("poder|v#pres.1s", "es2sv")!, store.card("casa|n", "es2sv")!]);
    s.avsta();
    expect(store.avstadd("poder|v#pres.1s")).toBe(true);
    expect(store.avstadd("poder|v")).toBe(false);
    expect(s.current!.wordId).toBe("casa|n");
  });

  it("pausad övning: avstådda ord hoppar av vid återupptagning", () => {
    store.introduceUnits(2);
    store.setAvstadd("poder|v", true);
    const s = Session.restore(store, {
      queue: [["poder|v", "es2sv"], ["casa|n", "es2sv"]],
      done: 0, counts: { good: 0, hard: 0, again: 0 }, baseline: 0,
    });
    expect(s.queue.map((c) => c.wordId)).toEqual(["casa|n"]);
  });

  it("stegen i ordlistan tar tillbaka ordet — setLevel rensar flaggan", () => {
    store.introduceUnits(1);
    store.setAvstadd("poder|v", true);
    store.setLevel("poder|v", "ovar");
    expect(store.avstadd("poder|v")).toBe(false);
  });

  it("molnsynk: skip-flaggan följer med i merge", () => {
    const data = emptyData();
    mergeCloudIntoLocal(data, {
      cards: [], settings: null, snapshots: [], reviewTs: [],
      userWords: [{ word_id: "casa|n", syn: [], mnem: "", skip: true, updated_at: "2026-01-01T00:00:00Z" }],
    });
    expect(data.userWords["casa|n"].skip).toBe(true);
    // utan kolumn (äldre moln): flaggan lämnas orörd = false
    mergeCloudIntoLocal(data, {
      cards: [], settings: null, snapshots: [], reviewTs: [],
      userWords: [{ word_id: "perro|n", syn: [], mnem: "", updated_at: "2026-01-01T00:00:00Z" }],
    });
    expect(data.userWords["perro|n"].skip).toBeUndefined();
  });
});
