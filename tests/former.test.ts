import { beforeEach, describe, expect, it } from "vitest";
import { newCardRec } from "../src/lib/scheduler";
import { Session } from "../src/lib/session";
import { Store } from "../src/lib/store";
import { emptyData, type StorageAdapter } from "../src/lib/storage";
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
  { id: "querer|v#pres.1s", parent: "querer|v", es: "quiero", person: "1s", svPres: "vill", r: 67, slot: 1 },
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
  store.data.settings.newPerDay = 10;
  return store;
}

/** Klara moderverbets es→sv-kort en gång (låser upp formerna). */
function unlockParent(store: Store, id: string): void {
  const s = new Session(store, [store.card(id, "es2sv")!]);
  s.answer(store.byId.get(id)!.sv);
  s.commit();
}

describe("böjningsformer: introduktion", () => {
  let store: Store;
  beforeEach(() => { store = makeStore(); });

  it("former är låsta före första klarningen — och flödar in direkt efter (via återbäringen)", () => {
    const units = store.nextIntroUnits(10);
    expect(units.every((u) => u.kind === "word")).toBe(true); // inget upplåst än
    store.introduceUnits(4); // alla fyra orden
    expect(store.card("poder|v#pres.1s", "es2sv")).toBeUndefined();
    unlockParent(store, "poder|v"); // exakt rätt ⇒ fast-track ⇒ återbäringen tar nästa enhet
    // nästa enhet i kön var just puedo (slot 1) — den introducerades automatiskt
    expect(store.card("poder|v#pres.1s", "es2sv")).toBeTruthy();
  });

  it("max en ny form per verb och dag", () => {
    store.introduceUnits(4);
    unlockParent(store, "poder|v"); // puedo introduceras via återbäringen
    const units = store.nextIntroUnits(10);
    // puede (samma verb) får vänta till imorgon
    expect(units.some((u) => u.kind === "form" && u.form.parent === "poder|v")).toBe(false);
  });

  it("upplåsta former slår ord med sämre korpusläge (slot före rank)", () => {
    store.introduceUnits(2); // poder + casa
    store.data.settings.newPerDay = 0; // stäng av återbäringen (tak 0) för ren ordningstest
    unlockParent(store, "poder|v");
    const units = store.nextIntroUnits(2);
    // puedo (slot 1) ska komma före querer (rank 3)
    expect(units[0]).toMatchObject({ kind: "form" });
    expect(units[1]).toMatchObject({ kind: "word" });
  });

  it("introducerade former delar dagsbudgeten", () => {
    store.introduceUnits(4);
    unlockParent(store, "poder|v");
    expect(store.introducedToday()).toBe(5); // 4 ord + puedo via återbäringen
  });
});

describe("böjningsformer: rättning & rendering-data", () => {
  let store: Store;
  beforeEach(() => {
    store = makeStore();
    store.introduceUnits(4);
    unlockParent(store, "poder|v");
    store.introduceUnits(1); // puedo introduceras (båda riktningarna)
  });

  it("es→sv: 'jag kan' är facit, blotta verbet accepteras också", () => {
    const card = store.card("poder|v#pres.1s", "es2sv")!;
    const s = new Session(store, [card]);
    expect(s.answer("jag kan").grade).toBe("good");
    const s2 = new Session(store, [store.card("poder|v#pres.1s", "es2sv")!]);
    expect(s2.answer("kan").grade).toBe("good");
  });

  it("es→sv 3s: 'han …', 'hon …', 'den/det …' räknas alla som rätt — aldrig snedstreck i facit", () => {
    store.putCard(newCardRec("poder|v#pres.3s", "es2sv", new Date()));
    for (const svar of ["han kan", "hon kan", "den kan", "det kan", "kan"]) {
      const s = new Session(store, [store.card("poder|v#pres.3s", "es2sv")!]);
      expect(s.answer(svar).grade, `"${svar}" ska ge rätt`).toBe("good");
    }
  });

  it("'jag hade rätt' på formkort: synonymen sparas på formen — och rättas nästa gång", () => {
    const card = store.card("poder|v#pres.1s", "sv2es")!;
    const s = new Session(store, [card]);
    expect(s.answer("puedoo").grade).not.toBe("good");
    s.override();
    s.commit();
    expect(store.userWord("poder|v#pres.1s").syn).toContain("puedoo");
    expect(store.userWord("poder|v").syn).toHaveLength(0); // moderverbet förorenas inte
    const s2 = new Session(store, [store.card("poder|v#pres.1s", "sv2es")!]);
    expect(s2.answer("puedoo").grade).toBe("good");
  });

  it("sv→es: formen krävs — grundverbet räknas inte", () => {
    const card = store.card("poder|v#pres.1s", "sv2es")!;
    const s = new Session(store, [card]);
    const p = s.answer("poder");
    expect(p.grade).not.toBe("good");
  });

  it("pending bär moderordet och formen (för stödraden + delad minnesregel)", () => {
    const card = store.card("poder|v#pres.1s", "es2sv")!;
    const s = new Session(store, [card]);
    const p = s.answer("jag kan");
    expect(p.word.id).toBe("poder|v");
    expect(p.form?.es).toBe("puedo");
  });

  it("tvåfelsregeln på ett formkort tvingar minnesregel — som hamnar på moderverbet", () => {
    const card = store.card("poder|v#pres.1s", "sv2es")!;
    const s = new Session(store, [card]);
    s.answer("fel"); s.commit();
    const p2 = s.answer("fel igen");
    expect(p2.forcedMnem).toBe(true);
    store.setMnem(p2.word.id, "PUEDO-regeln");
    expect(store.userWord("poder|v").mnem).toBe("PUEDO-regeln");
  });

  it("sv-promptkrock utan hint ⇒ båda formerna accepteras", () => {
    // ge querer samma svPres som poder (konstruerat) och lås upp
    store.forms.find((f) => f.id === "querer|v#pres.1s")!.svPres = "kan";
    // bygg accept-listorna som loadForms gör: krock utan hint → korsaccept
    const a = store.forms.find((f) => f.id === "poder|v#pres.1s")!;
    const b = store.forms.find((f) => f.id === "querer|v#pres.1s")!;
    a.accept = [b.es]; b.accept = [a.es];
    const card = store.card("poder|v#pres.1s", "sv2es")!;
    const s = new Session(store, [card]);
    expect(s.answer("quiero").grade).toBe("good");
  });
});
