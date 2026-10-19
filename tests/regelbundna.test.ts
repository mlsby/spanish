import { describe, expect, it } from "vitest";
import { Session } from "../src/lib/session";
import { newCardRec } from "../src/lib/scheduler";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
import type { AppData, VerbForm, Word } from "../src/lib/types";

class MemAdapter implements StorageAdapter {
  d: AppData | null = null;
  load() { return this.d; }
  save(x: AppData) { this.d = x; }
}

const WORDS: Word[] = [
  { id: "hablar|v", rank: 1, es: "hablar", pos: "v", sv: "prata", syn: ["tala"] },
  { id: "conocer|v", rank: 2, es: "conocer", pos: "v", sv: "känna", syn: [] },
  { id: "aparecer|v", rank: 3, es: "aparecer", pos: "v", sv: "dyka upp", syn: [] },
];
const f = (parent: string, person: VerbForm["person"], es: string, svPres: string): VerbForm =>
  ({ id: `${parent}#pres.${person}`, parent, es, person, svPres, r: 100, slot: 1 });
const FORMS: VerbForm[] = [
  f("hablar|v", "3s", "habla", "pratar"), f("hablar|v", "1s", "hablo", "pratar"),
  f("conocer|v", "3s", "conoce", "känner"), f("conocer|v", "1s", "conozco", "känner"),
  f("aparecer|v", "3s", "aparece", "dyker upp"),
];
const LAS = {
  "hablar|v": ["hablo", "hablas", "habla", "hablamos", "hablan"],
  "conocer|v": ["conozco", "conoces", "conoce", "conocemos", "conocen"],
  "aparecer|v": ["aparece", "aparecen"], // jag-formen saknas — kan vara -zco
};

function makeStore(): Store {
  const store = new Store(new MemAdapter());
  store.words = WORDS;
  store.byId = new Map(WORDS.map((w) => [w.id, w]));
  store.data = emptyData();
  store.setForms({ forms: FORMS.map((x) => ({ ...x })), las: LAS });
  return store;
}

/** hablar har klarats en gång — böjningarna är upplåsta. */
function lasUpp(store: Store, id = "hablar|v"): void {
  for (const dir of ["es2sv", "sv2es"] as const) {
    const c = newCardRec(id, dir, new Date());
    c.fsrs.reps = 1; c.fsrs.stability = 3; c.fsrs.difficulty = 5; c.fsrs.state = 2;
    c.fsrs.due = new Date(Date.now() - 3600e3).toISOString();
    store.data.cards[`${id}:${dir}`] = c;
  }
}

describe("regelbundna verb", () => {
  it("klassas på belagda former: jag-formen måste finnas och följa regeln", () => {
    const store = makeStore();
    expect([...store.regularVerbs]).toEqual(["hablar|v"]);
    expect(store.varianterByParent.get("hablar|v")!.map((x) => x.es))
      .toEqual(["hablo", "hablas", "habla", "hablamos", "hablan"]);
    expect(store.kortForms.map((x) => x.parent)).toEqual(["conocer|v", "conocer|v", "aparecer|v"]);
  });

  it("gamla formkort för regelbundna verb vilar: ingen krasch, inte i passet, inte i poängen", () => {
    const store = makeStore();
    const gammal = newCardRec("hablar|v#pres.3s", "es2sv", new Date(Date.now() - 86400e3));
    gammal.fsrs.reps = 2;
    store.data.cards["hablar|v#pres.3s:es2sv"] = gammal;
    expect(store.vilande("hablar|v#pres.3s")).toBe(true);
    expect(store.portionsPlan().rep).toHaveLength(0);
    expect(store.stats().score).toBe(0);
    expect(store.stats().total).toBe(WORDS.length + 3);
    expect(store.card("hablar|v#pres.3s", "es2sv")).toBeDefined(); // kortet finns kvar
  });

  it("före första klarningen frågas infinitiven", () => {
    const store = makeStore();
    const s = new Session(store, [newCardRec("hablar|v", "es2sv", new Date())]);
    expect(s.formFor(s.current!)).toBeUndefined();
  });

  it("efter upplåsning frågas en slumpad person — samma tills kortet besvarats", () => {
    const store = makeStore();
    lasUpp(store);
    const s = new Session(store, [store.card("hablar|v", "es2sv")!], { rand: () => 0.3 });
    const a = s.formFor(s.current!)!;
    expect(a.parent).toBe("hablar|v");
    expect(s.formFor(s.current!)).toBe(a);
    expect(s.formFor(s.current!)).toBe(a);
  });

  it("böjningen rättas: hablas → 'du pratar' och 'du pratar' → hablas", () => {
    const store = makeStore();
    lasUpp(store);
    const s = new Session(store, [store.card("hablar|v", "es2sv")!, store.card("hablar|v", "sv2es")!],
      { rand: () => 0.2 }); // index 1 av fem = 2s
    const p = s.answer("du pratar");
    expect(p.form?.es).toBe("hablas");
    expect(p.grade).toBe("good");
    s.commit();
    const q = s.answer("hablas");
    expect(q.form?.person).toBe("2s");
    expect(q.grade).toBe("good");
  });

  it("fel svar: nytt försök i en annan person", () => {
    const store = makeStore();
    lasUpp(store);
    const s = new Session(store, [store.card("hablar|v", "es2sv")!], { rand: () => 0 });
    const forst = s.formFor(s.current!)!;
    s.answer("fel"); s.commit();
    expect(s.current?.wordId).toBe("hablar|v");
    expect(s.formFor(s.current!)!.person).not.toBe(forst.person);
  });

  it("oregelbundna verb: högst en böjning per dag, de andra väntar", () => {
    const store = makeStore();
    const now = new Date();
    for (const id of ["conocer|v#pres.1s", "conocer|v#pres.3s"]) {
      const c = newCardRec(id, "es2sv", now);
      c.fsrs.reps = 1; c.fsrs.stability = 3; c.fsrs.difficulty = 5; c.fsrs.state = 2;
      c.fsrs.due = new Date(now.getTime() - 3600e3).toISOString();
      store.data.cards[`${id}:es2sv`] = c;
    }
    expect(store.portionsPlan(now).rep).toHaveLength(1);
    const s = new Session(store, store.startPortion(now));
    const forsta = s.current!.wordId;
    s.answer(s.formFor(s.current!)!.svPres); s.commit(now);
    expect(store.portionsPlan(now).rep.some((c) => c.wordId.startsWith("conocer"))).toBe(false);
    expect(forsta.startsWith("conocer|v#pres.")).toBe(true);
  });

  it("'jag hade rätt' sparar synonymen på den frågade formen", () => {
    const store = makeStore();
    lasUpp(store);
    const s = new Session(store, [store.card("hablar|v", "es2sv")!], { rand: () => 0 });
    s.answer("jag snackar");
    s.override();
    expect(store.userWord("hablar|v#pres.1s").syn).toContain("jag snackar");
  });
});
