import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/lib/session";
import { applyReview, isKnown, newCardRec } from "../src/lib/scheduler";
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

describe("repetera-knappen", () => {
  it("ger alltid ett lagom pass: förfallna först, påfyllt med närmast förfallande, max 20", () => {
    const store = makeStore();
    const now = Date.now();
    // ett förfallet + två kommande sedda kort
    const mk = (id: string, dir: "es2sv" | "sv2es", dueMs: number) => {
      const c = newCardRec(id, dir, new Date());
      c.fsrs.reps = 1;
      c.fsrs.due = new Date(dueMs).toISOString();
      store.data.cards[`${id}:${dir}`] = c;
    };
    mk("empezar|v", "es2sv", now - 3600e3);        // förfallet
    mk("ciudad|n", "es2sv", now + 5 * 86400e3);    // om 5 dagar
    mk("feliz|adj", "es2sv", now + 2 * 86400e3);   // om 2 dagar
    const cards = store.repCards();
    expect(cards).toHaveLength(3); // inte bara det förfallna
    expect(cards[0].wordId).toBe("empezar|v");     // mest brådskande först
    expect(cards[1].wordId).toBe("feliz|adj");
    expect(cards.length).toBeLessThanOrEqual(20);
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

  it("stavfel → hard i UI:t, synonym → good", () => {
    const card = newCardRec("empezar|v", "es2sv", new Date());
    const s = new Session(store, [card]);
    expect(s.answer("börjaa").grade).toBe("hard");
    s.commit();
    const s2 = new Session(store, [store.card("empezar|v", "es2sv")!]);
    expect(s2.answer("starta").grade).toBe("good");
  });

  it("svenskt stavfel straffas inte: FSRS får good, loggen visar fuzzy", () => {
    // es→sv-stavfel ("börjaa") rättas som vanlig Good (inte Easy — det är
    // "kan redan"-knappens jobb) — samma stabilitet som ett rent Good-svar
    const a = new Session(store, [newCardRec("empezar|v", "es2sv", new Date())]);
    a.answer("börjaa"); a.commit();
    const typo = store.card("empezar|v", "es2sv")!.fsrs.stability;
    expect(store.data.reviews[store.data.reviews.length - 1]).toMatchObject({ grade: "good", step: "fuzzy" });
    const ref = applyReview(newCardRec("feliz|adj", "es2sv", new Date()), "good", new Date());
    expect(typo).toBe(ref.fsrs.stability);
    // spanskt stavfel förblir hard — stavningen ÄR kunskapen åt det hållet
    const c = new Session(store, [newCardRec("ciudad|n", "sv2es", new Date())]);
    c.answer("ciudda"); c.commit();
    expect(store.data.reviews[store.data.reviews.length - 1]).toMatchObject({ grade: "hard", step: "fuzzy" });
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
  it("kräver stabilitet ≥ 21 dagar (Anki-mature)", () => {
    const rec = newCardRec("empezar|v", "es2sv", new Date());
    expect(isKnown(rec)).toBe(false);
    rec.fsrs.stability = 20.9;
    expect(isKnown(rec)).toBe(false);
    rec.fsrs.stability = 21;
    expect(isKnown(rec)).toBe(true);
  });
});

describe("poängen räknar böjningsformer", () => {
  it("ett besvarat formkort ger score precis som ett ord", () => {
    const store = makeStore();
    const form = {
      id: "empezar|v#pres.1s", parent: "empezar|v", es: "empiezo",
      person: "1s" as const, svPres: "börjar", r: 500, slot: 1,
    };
    store.forms = [form];
    store.formById = new Map([[form.id, form]]);
    expect(store.stats().score).toBe(0);

    const rec = newCardRec(form.id, "es2sv", new Date());
    rec.fsrs.reps = 1; // besvarad → "på gång" → poäng
    store.putCard(rec);
    expect(store.stats().score).toBe(1);
    expect(store.stats().total).toBe(WORDS.length + 1);
  });
});
