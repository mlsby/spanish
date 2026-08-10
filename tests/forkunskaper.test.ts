import { beforeEach, describe, expect, it } from "vitest";
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
  { id: "gato|n", rank: 4, es: "gato", pos: "n", sv: "katt", syn: [], art: "el" },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  store.data.settings.newFirst = 2;
  store.data.settings.newMore = 2;
  return store;
}

describe("förkunskaps-fast-track", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("exakt rätt vid första mötet ⇒ Easy: långt intervall, ingen kortsiktig återkomst", () => {
    const fresh = store.introduceForSession();
    const s = new Session(store, fresh);
    const first = s.current!;
    expect(first.dir).toBe("es2sv");
    const p = s.answer("hej");
    expect(p).toMatchObject({ grade: "good", firstExposure: true, easy: true });
    s.commit();
    const saved = store.card(first.wordId, "es2sv")!;
    expect(saved.fsrs.stability).toBeGreaterThan(5); // dagar/veckor — inte korttidssteg
    // kortet kom INTE tillbaka i kön (ingen 10-minutersvända)
    expect(s.queue.some((c) => c.wordId === first.wordId && c.dir === "es2sv")).toBe(false);
  });

  it("andra mötet ger vanlig Good — ingen fast-track", () => {
    const fresh = store.introduceForSession();
    const s = new Session(store, fresh);
    const id = s.current!.wordId;
    s.answer("hej"); s.commit(); // första mötet: easy + syskonuppskov
    // ta samma kort igen (nästa dag): reps är nu 1
    const again = store.card(id, "es2sv")!;
    const s2 = new Session(store, [again]);
    const p = s2.answer("hej");
    expect(p.firstExposure).toBe(false);
    expect(p.easy).toBe(false);
  });

  it("stavfel vid första mötet ⇒ hard, men 'kan redan' uppgraderar till Easy", () => {
    const fresh = store.introduceForSession();
    const s = new Session(store, fresh);
    const id = s.current!.wordId;
    const p = s.answer("hejj");
    expect(p).toMatchObject({ grade: "hard", firstExposure: true, easy: false });
    const claimed = s.claimKnown();
    expect(claimed).toMatchObject({ grade: "good", easy: true, step: "override" });
    s.commit();
    expect(store.card(id, "es2sv")!.fsrs.stability).toBeGreaterThan(5);
  });

  it("syskonuppskov: sv→es-kortet lämnar kön och väntar ~2 veckor", () => {
    const fresh = store.introduceForSession();
    const s = new Session(store, fresh);
    const id = s.current!.wordId;
    expect(s.queue.some((c) => c.wordId === id && c.dir === "sv2es")).toBe(true);
    s.answer("hej"); s.commit();
    expect(s.queue.some((c) => c.wordId === id && c.dir === "sv2es")).toBe(false);
    const sib = store.card(id, "sv2es")!;
    const days = (new Date(sib.fsrs.due).getTime() - Date.now()) / 86400e3;
    expect(days).toBeGreaterThan(12);
    expect(sib.fsrs.reps).toBe(0); // orört första möte — fast-track gäller när det dyker upp
  });

  it("fel eller stavfel utan claim ⇒ syskonet blir kvar i kön", () => {
    const fresh = store.introduceForSession();
    const s = new Session(store, fresh);
    const id = s.current!.wordId;
    s.answer("hejj"); s.commit(); // hard utan claim
    expect(s.queue.some((c) => c.wordId === id && c.dir === "sv2es")).toBe(true);
  });

  it("budgetåterbäring: fast-track på dagens ord låser upp nästa enhet — med 3×-tak", () => {
    const fresh = store.introduceForSession(); // 2 ord (hola, casa)
    expect(store.introducedToday()).toBe(2);
    const s = new Session(store, fresh);
    s.answer("hej"); s.commit(); // fast-track → återbäring
    expect(store.introducedToday()).toBe(3); // perro introducerades i bakgrunden
    // nya kortet ligger INTE i pågående kö — det kommer i nästa pass
    expect(s.queue.some((c) => c.wordId === "perro|n")).toBe(false);
    // kör i botten: taket är 3× dagstakten = 6 introduktioner
    const s2 = new Session(store, store.dueCards().filter((c) => c.fsrs.reps === 0));
    let guard = 40;
    while (!s2.finished && guard-- > 0) {
      const cur = s2.current!;
      const w = store.wordFor(cur);
      s2.answer(cur.dir === "es2sv" ? w.sv : w.es);
      s2.commit();
    }
    expect(store.introducedToday()).toBeLessThanOrEqual(6);
  });
});

describe("prognos & broms i vanliga övningar", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("prognosen växer när nya ord tas in — baslinjen mäts före introduktionen", () => {
    const baseline = store.dueSoonCount();
    const fresh = store.introduceForSession();
    const s = new Session(store, fresh, { dueSoonBaseline: baseline });
    const cur = s.current!;
    s.answer("heeeelt fel svar");
    s.commit();
    expect(s.forecastAdded()).toBeGreaterThan(0);
    expect(s.queue.some((c) => c.wordId === cur.wordId && c.dir === cur.dir)).toBe(true); // omköad
  });
});
