import { describe, expect, it, vi } from "vitest";
import {
  byggQuiz, byggUnderlag, hamtaText, kandidatYtor, lasCommit, lasNiva, lasSystemPrompt,
  minnsQuizzade, ordITexten, valideraText,
} from "../src/lib/lastext";
import type { SupabaseClient } from "../src/lib/supabase";
import { applyReview, newCardRec } from "../src/lib/scheduler";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import { cardKey, type AppData, type Dir, type VerbForm, type Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "ser|v", rank: 1, es: "ser", pos: "v", sv: "vara", syn: [] },
  { id: "casa|n", rank: 2, es: "casa", pos: "n", sv: "hus", syn: [], art: "la" },
  { id: "otro|determiner", rank: 3, es: "otro", pos: "determiner", sv: "annan", syn: [] },
  { id: "cada|determiner", rank: 4, es: "cada", pos: "determiner", sv: "varje", syn: [] },
  { id: "feliz|adj", rank: 5, es: "feliz", pos: "adj", sv: "lycklig", syn: [] },
];
const FORMS: VerbForm[] = [
  { id: "ser|v#pres.3s", parent: "ser|v", es: "es", person: "3s", svPres: "är", r: 8, slot: 3 },
];

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.forms = FORMS;
  store.formById = new Map(FORMS.map((f) => [f.id, f]));
  store.formsByParent = new Map();
  for (const f of FORMS) {
    store.formsByParent.set(f.parent, [...(store.formsByParent.get(f.parent) ?? []), f]);
  }
  store.data = emptyData();
  return store;
}

/** Lägg ett besvarat kort med given stabilitet i datan (riktig review i botten). */
function seedCard(store: Store, id: string, dir: Dir, s: number, reps = 1): void {
  let rec = newCardRec(id, dir, new Date("2026-08-01"));
  rec = applyReview(rec, "good", new Date("2026-08-01T10:00:00Z"));
  rec.fsrs.stability = s;
  rec.fsrs.reps = reps;
  store.data.cards[cardKey(id, dir)] = rec;
}

describe("lasNiva", () => {
  it("trappan följer titlarna", () => {
    expect(lasNiva(100)).toEqual({ meningar: 3, anvand: 2 });
    expect(lasNiva(250)).toEqual({ meningar: 4, anvand: 3 });
    expect(lasNiva(700)).toEqual({ meningar: 5, anvand: 4 });
    expect(lasNiva(1500)).toEqual({ meningar: 6, anvand: 5 });
    expect(lasNiva(2400)).toEqual({ meningar: 8, anvand: 6 });
  });
});

describe("byggUnderlag", () => {
  it("kandidater = sköraste mötta först, kan-ord blir palett", () => {
    const store = makeStore();
    seedCard(store, "ser|v", "es2sv", 30); seedCard(store, "ser|v", "sv2es", 30);
    seedCard(store, "casa|n", "es2sv", 30); seedCard(store, "casa|n", "sv2es", 30);
    seedCard(store, "cada|determiner", "es2sv", 0.3); seedCard(store, "cada|determiner", "sv2es", 8);
    seedCard(store, "feliz|adj", "es2sv", 2); seedCard(store, "feliz|adj", "sv2es", 21);
    const u = byggUnderlag(store, 4);
    expect(u.kandidater.map((k) => k.es).sort()).toEqual(["cada", "feliz"]); // de sköra, ej kan-orden
    expect(u.kan).toContain("la casa");
    // mött verb ⇒ hela presensparadigmet får läsas, även omötta former
    expect(u.kan).toContain("ser (es)");
    expect(u.vitlista).toContain("es");
  });

  it("böjningsformer blir aldrig kandidater — bara grundord", () => {
    const store = makeStore();
    seedCard(store, "ser|v", "es2sv", 30); seedCard(store, "ser|v", "sv2es", 30);
    seedCard(store, "ser|v#pres.3s", "es2sv", 0.5); // skör form — får inte bli kandidat
    seedCard(store, "cada|determiner", "es2sv", 1); seedCard(store, "cada|determiner", "sv2es", 1);
    const u = byggUnderlag(store, 2);
    expect(u.kandidater.map((k) => k.es)).toEqual(["cada"]);
    expect(u.kan).toContain("ser (es)"); // verbet ligger kvar i listan med sina former
    expect(u.vitlista).toContain("es");
  });

  it("nivåerna delas: kan-ord och nästan-ord i skilda listor", () => {
    const store = makeStore();
    seedCard(store, "casa|n", "es2sv", 30); seedCard(store, "casa|n", "sv2es", 30);
    seedCard(store, "otro|determiner", "es2sv", 9); seedCard(store, "otro|determiner", "sv2es", 9);
    seedCard(store, "cada|determiner", "es2sv", 1); seedCard(store, "cada|determiner", "sv2es", 1);
    const u = byggUnderlag(store, 1, { rng: () => 0.99 }); // rng-valet landar på cada
    expect(u.kan).toContain("la casa");
    expect(u.nastan).toContain("otro");
    expect(u.kan).not.toContain("otro");
    // kandidaten står bara i kandidatlistan, inte i nivålistorna
    expect(u.kandidater.map((k) => k.es)).toEqual(["cada"]);
    expect([...u.kan, ...u.nastan]).not.toContain("cada");
    expect(u.vitlista).toContain("cada"); // men den måste få förekomma i texten
  });

  it("vitlistan expanderar plural, femininum, glue-småord och verbglue", () => {
    const store = makeStore();
    seedCard(store, "casa|n", "es2sv", 30); seedCard(store, "casa|n", "sv2es", 30);
    seedCard(store, "otro|determiner", "es2sv", 30); seedCard(store, "otro|determiner", "sv2es", 30);
    seedCard(store, "feliz|adj", "es2sv", 30); seedCard(store, "feliz|adj", "sv2es", 30);
    const u = byggUnderlag(store, 1, { rng: () => 0 });
    for (const t of ["casas", "otra", "otros", "felices", "a", "al", "del", "no", "la",
      "es", "son", "está", "están", "hay"]) {
      expect(u.vitlista, t).toContain(t);
    }
  });
});

describe("byggUnderlag — slump och exkludering", () => {
  function fyraSkora(): Store {
    const store = makeStore();
    seedCard(store, "ser|v", "es2sv", 1); seedCard(store, "ser|v", "sv2es", 1);
    seedCard(store, "casa|n", "es2sv", 2); seedCard(store, "casa|n", "sv2es", 2);
    seedCard(store, "otro|determiner", "es2sv", 3); seedCard(store, "otro|determiner", "sv2es", 3);
    seedCard(store, "cada|determiner", "es2sv", 4); seedCard(store, "cada|determiner", "sv2es", 4);
    return store;
  }

  it("urvalet slumpas ur fönstret — olika rng ger olika kandidater", () => {
    const store = fyraSkora();
    const a = byggUnderlag(store, 2, { rng: () => 0 }).kandidater.map((k) => k.es).sort();
    const b = byggUnderlag(store, 2, { rng: () => 0.99 }).kandidater.map((k) => k.es).sort();
    expect(a).not.toEqual(b);
  });

  it("förra läsningens ord undviks när poolen räcker", () => {
    const store = fyraSkora();
    const u = byggUnderlag(store, 2, {
      exkludera: new Set(["ser|v", "casa|n"]),
      rng: () => 0,
    });
    for (const k of u.kandidater) expect(["otro", "cada"]).toContain(k.es);
  });

  it("exkludering ignoreras om poolen inte räcker", () => {
    const store = makeStore();
    seedCard(store, "ser|v", "es2sv", 1); seedCard(store, "ser|v", "sv2es", 1);
    const u = byggUnderlag(store, 2, { exkludera: new Set(["ser|v"]), rng: () => 0 });
    expect(u.kandidater.map((k) => k.es)).toEqual(["ser"]);
    expect(u.vitlista).toContain("ser"); // paletten rörs inte heller när exkluderingen är av
  });

  it("uteslutna ord försvinner även ur palett och vitlista", () => {
    const store = fyraSkora();
    const u = byggUnderlag(store, 2, { exkludera: new Set(["cada|determiner"]), rng: () => 0 });
    expect([...u.kan, ...u.nastan]).not.toContain("cada");
    expect(u.vitlista).not.toContain("cada");
    expect(u.vitlista).toContain("casa"); // övriga palettord kvar
  });

  it("minnsQuizzade: nyaste först, dubbletter bort, taket håller", () => {
    expect(minnsQuizzade(["a", "b", "c"], ["c", "d"], 4)).toEqual(["c", "d", "a", "b"]);
    expect(minnsQuizzade(["a", "b", "c"], ["d", "e"], 4)).toEqual(["d", "e", "a", "b"]);
    expect(minnsQuizzade([], ["x"], 4)).toEqual(["x"]);
  });
});

describe("byggQuiz + ordITexten", () => {
  const kandidater = [
    { id: "cada|determiner", es: "cada", sv: "varje" },
    { id: "feliz|adj", es: "feliz", sv: "lycklig" },
  ];

  it("matchar hela ord, inte delsträngar", () => {
    expect(ordITexten("es", "Ella es feliz.")).toBe(true);
    expect(ordITexten("es", "La escuela está aquí.")).toBe(false);
  });

  it("en fråga per mening, i textens ordning, med fallback när taggen saknas", () => {
    const quiz = byggQuiz([
      { es: "Cada día voy a casa.", ovningsord: "cada" },
      { es: "Mi amigo es feliz.", ovningsord: "" }, // otaggad — hittas ändå
      { es: "Hola otra vez.", ovningsord: "" },
    ], kandidater);
    expect(quiz.map((q) => q.kandidat.es)).toEqual(["cada", "feliz"]);
    expect(quiz[1].mening).toBe("Mi amigo es feliz.");
  });

  it("samma kandidat quizzas aldrig två gånger", () => {
    const quiz = byggQuiz([
      { es: "Cada día.", ovningsord: "cada" },
      { es: "Cada noche.", ovningsord: "cada" },
    ], kandidater);
    expect(quiz).toHaveLength(1);
  });

  it("två kandidater i samma mening ger två frågor", () => {
    const quiz = byggQuiz([
      { es: "Cada día es feliz.", ovningsord: "cada" },
    ], kandidater);
    expect(quiz.map((q) => q.kandidat.es).sort()).toEqual(["cada", "feliz"]);
    expect(quiz[0].mening).toBe("Cada día es feliz.");
  });
});

describe("valideraText + hamtaText (klienten äger regler och omförsök)", () => {
  const underlag = {
    kan: ["la casa"],
    nastan: [],
    kandidater: [{ id: "cada|determiner", es: "cada", sv: "varje" }],
    vitlista: ["cada", "casa", "la", "es", "el", "hombre"],
  };

  it("valideraText: otillåtna ord och kandidatkravet", () => {
    const ok = valideraText(underlag, 1, [{ es: "Cada casa es la casa.", ovningsord: "cada" }]);
    expect(ok).toMatchObject({ godkand: true, brott: [], anvanda: ["cada"] });
    const brott = valideraText(underlag, 1, [{ es: "Cada perro corre.", ovningsord: "cada" }]);
    expect(brott.godkand).toBe(false);
    expect(brott.brott.sort()).toEqual(["corre", "perro"]);
    const utanKandidat = valideraText(underlag, 1, [{ es: "La casa es la casa.", ovningsord: "" }]);
    expect(utanKandidat).toMatchObject({ godkand: false, anvanda: [] });
  });

  it("systemprompten bär nivåvärdena och verbgluet", () => {
    const s = lasSystemPrompt({ meningar: 5, anvand: 4 });
    expect(s).toContain("ungefär 5 meningar");
    expect(s).toContain("exakt 4 kandidatord");
    expect(s).toContain("es, son, está, están, hay");
  });

  function fakeSb(svar: string[]): { sb: SupabaseClient; invoke: ReturnType<typeof vi.fn> } {
    const invoke = vi.fn(async () => ({ data: { text: svar.shift() ?? "" }, error: null }));
    return { sb: { functions: { invoke } } as unknown as SupabaseClient, invoke };
  }

  it("hamtaText: underkänt försök ger omförsök med felen i prompten", async () => {
    const daligt = JSON.stringify({ meningar: [{ es: "Cada perro corre.", ovningsord: "cada" }] });
    const bra = JSON.stringify({ meningar: [{ es: "Cada casa es la casa.", ovningsord: "cada" }] });
    const { sb, invoke } = fakeSb([daligt, bra]);
    const meningar = await hamtaText(sb, underlag, { meningar: 3, anvand: 1 });
    expect(meningar[0].es).toBe("Cada casa es la casa.");
    expect(invoke).toHaveBeenCalledTimes(2);
    const andra = invoke.mock.calls[1][1].body;
    expect(andra.user).toContain("Otillåtna ord: perro, corre");
    expect(andra.system).toBe(invoke.mock.calls[0][1].body.system);
  });

  it("hamtaText: tre underkända försök ger fel — hellre lucka än fel text", async () => {
    const daligt = JSON.stringify({ meningar: [{ es: "Cada perro corre.", ovningsord: "cada" }] });
    const { sb, invoke } = fakeSb([daligt, daligt, daligt]);
    await expect(hamtaText(sb, underlag, { meningar: 3, anvand: 1 }))
      .rejects.toThrow(/håller sig till dina ord/);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe("formacceptans — kandidatverb får böjas", () => {
  function verbStore(): Store {
    const store = makeStore();
    store.lasFormer = new Map([["ser|v", ["soy", "eres", "es", "somos", "son"]]]);
    return store;
  }

  it("kandidatYtor: verb ger grundform + presensformer, andra ord bara sig själva", () => {
    const store = verbStore();
    expect(kandidatYtor(store, { id: "ser|v", es: "ser", sv: "vara" }))
      .toEqual(["ser", "soy", "eres", "es", "somos", "son"]);
    expect(kandidatYtor(store, { id: "casa|n", es: "casa", sv: "hus" })).toEqual(["casa"]);
  });

  it("böjd kandidat räknas som använd och quizzas med den form som står i texten", () => {
    const store = verbStore();
    const kandidater = [{ id: "ser|v", es: "ser", sv: "vara" }];
    const ytor = (k: typeof kandidater[number]) => kandidatYtor(store, k);
    const meningar = [{ es: "Mi amigo es feliz.", ovningsord: "es" }];
    const u = { kan: [], nastan: [], kandidater, vitlista: ["mi", "amigo", "es", "feliz"] };
    expect(valideraText(u, 1, meningar, ytor)).toMatchObject({ godkand: true, anvanda: ["ser"] });
    const quiz = byggQuiz(meningar, kandidater, ytor);
    expect(quiz).toHaveLength(1);
    expect(quiz[0]).toMatchObject({ yta: "es", mening: "Mi amigo es feliz." });
    expect(quiz[0].kandidat.es).toBe("ser"); // förhöret gäller grundformen
  });

  it("utan formacceptans räknas den böjda formen inte", () => {
    const kandidater = [{ id: "ser|v", es: "ser", sv: "vara" }];
    const meningar = [{ es: "Mi amigo es feliz.", ovningsord: "es" }];
    const u = { kan: [], nastan: [], kandidater, vitlista: ["mi", "amigo", "es", "feliz"] };
    expect(valideraText(u, 1, meningar).godkand).toBe(false);
  });
});

describe("lasCommit", () => {
  it("uppdaterar es→sv-kortet och loggar reviewen; svenskt stavfel blir good", () => {
    const store = makeStore();
    seedCard(store, "cada|determiner", "es2sv", 0.3, 2);
    const fore = store.card("cada|determiner", "es2sv")!.fsrs;
    lasCommit(store, "cada|determiner", "hard", "varje", "fuzzy", new Date("2026-08-11"));
    const efter = store.card("cada|determiner", "es2sv")!;
    expect(efter.fsrs.reps).toBe(fore.reps + 1);
    expect(store.data.reviews[store.data.reviews.length - 1])
      .toMatchObject({ wordId: "cada|determiner", dir: "es2sv", grade: "good", step: "fuzzy" });
  });

  it("fel räknar upp failCount", () => {
    const store = makeStore();
    seedCard(store, "cada|determiner", "es2sv", 0.3, 2);
    lasCommit(store, "cada|determiner", "again", "", "none", new Date("2026-08-11"));
    expect(store.card("cada|determiner", "es2sv")!.failCount).toBe(1);
  });
});
