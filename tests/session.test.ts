import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/lib/session";
import { isKnown, newCardRec } from "../src/lib/scheduler";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData, Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "empezar|v", rank: 1, es: "empezar", pos: "v", sv: "börja", syn: ["starta"], alt: ["comenzar"] },
  { id: "ciudad|n", rank: 2, es: "ciudad", pos: "n", sv: "stad", syn: [], art: "la" },
  { id: "feliz|adj", rank: 3, es: "feliz", pos: "adj", sv: "lycklig", syn: [] },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  return store;
}

describe("övningsmodellen: dagens övning + öva mer", () => {
  it("dagens första övning fyller till newFirst — frekvensordning, es→sv först", () => {
    const store = makeStore();
    store.data.settings.newFirst = 2;
    const fresh = store.introduceForSession();
    expect(fresh).toHaveLength(4); // 2 ord × 2 riktningar
    // es→sv-korten först, sedan sv→es — samma ord förhörs inte rygg i rygg
    expect(fresh.map((c) => `${c.wordId}:${c.dir}`)).toEqual([
      "empezar|v:es2sv", "ciudad|n:es2sv", "empezar|v:sv2es", "ciudad|n:sv2es",
    ]);
    // omstart utan att ha övat: de osedda ärvs — inget staplas ovanpå
    expect(store.introduceForSession()).toHaveLength(0);
  });

  it("efter dagens första övning ger varje 'öva mer' newMore nya", () => {
    const store = makeStore();
    store.data.settings.newFirst = 1;
    store.data.settings.newMore = 1;
    expect(store.introduceForSession()).toHaveLength(2); // empezar
    // markera att första övningen skett: kortet besvarat + review loggad
    store.logReview({
      ts: new Date().toISOString(), wordId: "empezar|v", dir: "es2sv",
      raw: "börja", grade: "good", step: "exact",
    });
    for (const dir of ["es2sv", "sv2es"] as const) {
      const c = store.card("empezar|v", dir)!;
      store.putCard({ ...c, fsrs: { ...c.fsrs, reps: 1 } });
    }
    const more = store.introduceForSession();
    expect(more).toHaveLength(2); // +1 nytt ord
    expect(more[0].wordId).toBe("ciudad|n");
  });

  it("avbruten övning: osedda ord räknas av mot nästa övnings mål", () => {
    const store = makeStore();
    store.data.settings.newFirst = 2;
    store.data.settings.newMore = 1;
    store.introduceForSession(); // empezar + ciudad
    // öva bara ett kort (stavfel — ingen fast-track), hoppa av
    const s = new Session(store, store.dueCards());
    s.answer("börjaa");
    s.commit();
    // ciudad är fortfarande osedd (1) ≥ målet (1) → inget nytt introduceras
    expect(store.introduceForSession()).toHaveLength(0);
    expect(store.card("feliz|adj", "es2sv")).toBeUndefined();
  });

  it("osedda ord från en annan enhet räknas av — härlett ur korten", () => {
    const store = makeStore();
    store.data.settings.newFirst = 2;
    const now = new Date();
    for (const id of ["empezar|v", "ciudad|n"]) {
      store.data.cards[`${id}:es2sv`] = newCardRec(id, "es2sv", now);
      store.data.cards[`${id}:sv2es`] = newCardRec(id, "sv2es", now);
    }
    expect(store.introduceForSession()).toHaveLength(0); // målet redan täckt
  });

  it("stats beskriver nästa övning: firstToday, nextNew och bara sedda i due", () => {
    const store = makeStore();
    store.data.settings.newFirst = 2;
    store.data.settings.newMore = 1;
    let st = store.stats();
    expect(st.firstToday).toBe(true);
    expect(st.nextNew).toBe(2);
    expect(st.due).toBe(0);
    store.introduceForSession();
    st = store.stats();
    expect(st.nextNew).toBe(2); // ärvda osedda — samma övning, inte fler
    expect(st.due).toBe(0);     // osedda räknas som nya, inte repetitioner
  });
});

describe("session: betygsmappning och tvåfelsregeln", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
  });

  it("exakt svar → good, fsrs uppdateras och kortet lämnar kön", () => {
    const card = newCardRec("empezar|v", "es2sv", new Date());
    const s = new Session(store, [card]);
    const p = s.answer("börja");
    expect(p.grade).toBe("good");
    s.commit();
    expect(s.counts.good).toBe(1);
    const saved = store.card("empezar|v", "es2sv")!;
    expect(saved.fsrs.reps).toBe(1);
    expect(saved.fsrs.stability).toBeGreaterThan(0);
    expect(store.data.reviews).toHaveLength(1);
    expect(store.data.reviews[0]).toMatchObject({ grade: "good", step: "exact", raw: "börja" });
  });

  it("stavfel → hard, synonym → good", () => {
    const card = newCardRec("empezar|v", "es2sv", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("börjaa").grade).toBe("hard");
    s.commit();
    const s2 = new Session(store, [store.card("empezar|v", "es2sv")!]);
    expect(s2.answer("starta").grade).toBe("good");
  });

  it("sv→es: artikeln krävs inte", () => {
    const card = newCardRec("ciudad|n", "sv2es", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("ciudad").grade).toBe("good");
    const s2 = new Session(store, [newCardRec("ciudad|n", "sv2es", new Date())]);
    expect(s2.answer("la ciudad").grade).toBe("good");
  });

  it("es→sv: bestämd form räknas som rätt för substantiv — 'la ciudad' → 'staden'", () => {
    const s = new Session(store, [newCardRec("ciudad|n", "es2sv", new Date())]);
    expect(s.answer("staden").grade).toBe("good");
    // men inte för verb: böjda svenska verbformer är fortfarande inte facit
    const s2 = new Session(store, [newCardRec("empezar|v", "es2sv", new Date())]);
    expect(s2.answer("började").grade).not.toBe("good");
  });

  it("sv→es: alternativa spanska svar (alt) godkänns som synonym", () => {
    const s = new Session(store, [newCardRec("empezar|v", "sv2es", new Date())]);
    expect(s.answer("comenzar")).toMatchObject({ grade: "good", step: "syn" });
    const s2 = new Session(store, [newCardRec("empezar|v", "sv2es", new Date())]);
    expect(s2.answer("empezar").grade).toBe("good");
  });

  it("första felet: frivillig regel; andra felet: obligatorisk", () => {
    const card = newCardRec("feliz|adj", "es2sv", new Date());
    const s = new Session(store, [card]);
    const p1 = s.answer("glad");
    expect(p1.grade).toBe("again");
    expect(p1.forcedMnem).toBe(false); // första missen
    s.commit();
    expect(s.queue[0].failCount).toBe(1); // kortet kom tillbaka i kön
    const p2 = s.answer("nöjd");
    expect(p2.grade).toBe("again");
    expect(p2.forcedMnem).toBe(true); // andra missen → regel krävs
  });

  it("'vet inte' (tomt svar) → again, och tvåfelsregeln gäller som vanligt", () => {
    const card = newCardRec("feliz|adj", "es2sv", new Date());
    const s = new Session(store, [card]);
    const p1 = s.answer("");
    expect(p1).toMatchObject({ grade: "again", step: "none", forcedMnem: false });
    s.commit();
    expect(store.data.reviews[0]).toMatchObject({ grade: "again", raw: "" });
    const p2 = s.answer("");
    expect(p2.forcedMnem).toBe(true); // andra missen → regel krävs även via vet inte
  });

  it("'jag hade rätt' uppgraderar till hard och sparar synonymen", () => {
    const card = newCardRec("feliz|adj", "es2sv", new Date());
    const s = new Session(store, [card]);
    s.answer("glad");
    const p = s.override();
    expect(p.grade).toBe("hard");
    expect(p.step).toBe("override");
    expect(store.userWord("feliz|adj").syn).toContain("glad");
    s.commit();
    expect(store.data.reviews[0].step).toBe("override");
    // nästa gång rättas synonymen direkt utan override
    const s2 = new Session(store, [store.card("feliz|adj", "es2sv")!]);
    expect(s2.answer("glad").grade).toBe("good");
  });

  it("fel svar återkommer i samma pass tills det sitter", () => {
    const cards = ["empezar|v", "ciudad|n", "feliz|adj"].map((id) => newCardRec(id, "es2sv", new Date()));
    const s = new Session(store, cards);
    s.answer("fel svar");
    s.commit();
    expect(s.queue.map((c) => c.wordId)).toContain("empezar|v");
  });
});

describe("Kan det-etiketten", () => {
  it("kräver stabilitet ≥ 30 dagar", () => {
    const rec = newCardRec("empezar|v", "es2sv", new Date());
    expect(isKnown(rec)).toBe(false);
    rec.fsrs.stability = 31;
    expect(isKnown(rec)).toBe(true);
  });
});
