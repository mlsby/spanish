import type { AppData, CardRec, Dir, DirtyKind, Lage, Level, Niva, ReviewRec, UserWord, VerbForm, Word } from "./types";
import { cardKey, PERSON_SV, PERSON_SV_SVAR } from "./types";
import { svBestamd, svBojda } from "./grading";
import { dueDate, isKnown, KNOWN_STABILITY_DAYS, levelCardRec, newCardRec } from "./scheduler";
import { emptyData, LocalStorageAdapter, type StorageAdapter } from "./storage";
import { dayKey, endOfToday } from "./time";

/** Nästa enhet i introduktionskön: ett nytt ord eller en upplåst verbböjning. */
export type IntroUnit = { kind: "word"; word: Word } | { kind: "form"; form: VerbForm };

/** Ambitionsnivåerna: dagsbudget för nya ord. */
export const NIVAER: Record<Niva, { nya: number }> = {
  lugn: { nya: 15 },
  lagom: { nya: 20 },
  ambitios: { nya: 25 },
};

/** Presensändelser (1s, 2s, 3s, 1p, 3p) för regelbundna verb. */
const ANDELSER: Record<string, string[]> = {
  ar: ["o", "as", "a", "amos", "an"],
  er: ["o", "es", "e", "emos", "en"],
  ir: ["o", "es", "e", "imos", "en"],
};
const PERSONER: VerbForm["person"][] = ["1s", "2s", "3s", "1p", "3p"];

/** Dagens övning, uträknad men inte startad — hjälten visar den, Öva kör den. */
export interface PortionsPlan {
  rep: CardRec[];        // förfallna repetitioner, mest kritiska först
  unseen: CardRec[];     // ärvda: introducerade men aldrig besvarade
  nyaUnits: IntroUnit[]; // nya enheter inom dagsbudgeten — kommer när det förfallna är klart
  nyaOrd: number;        // deklarationens "nya ord" (ärvda + färska)
  repKort: number;       // deklarationens "repetitioner"
  totalKort: number;
}

export interface WordStatus {
  word: Word;
  cards: CardRec[];
  status: "ny" | "lar" | "kan";
  minStability: number;
  /** nivå för ordlistans stege: ny · övar (<7 d) · på gång (7–30 d) · kan det (≥30 d båda håll) */
  level: Level;
}

export class Store {
  words: Word[] = [];
  byId = new Map<string, Word>();
  forms: VerbForm[] = [];
  formById = new Map<string, VerbForm>();
  /** exempelmeningar (Tatoeba): ord-/form-id → [spansk mening, ev. svensk översättning] */
  examples = new Map<string, string[]>();
  formsByParent = new Map<string, VerbForm[]>();
  /**
   * Regelbundna verb (presens): böjningen är en regel, inte ord att minnas. De
   * har inga egna formkort — verbets kort frågar en slumpad person (se
   * varianter). Gamla formkort för dem ligger kvar orörda men vilar.
   */
  regularVerbs = new Set<string>();
  /** Regelbundna verbs alla fem presensformer (befintliga poster + genererade). */
  varianterByParent = new Map<string, VerbForm[]>();
  private kortFormsCache: { forms: VerbForm[]; size: number; out: VerbForm[] } | null = null;
  /** Formerna som får egna kort: de oregelbundna verbens. */
  get kortForms(): VerbForm[] {
    const c = this.kortFormsCache;
    if (c && c.forms === this.forms && c.size === this.regularVerbs.size) return c.out;
    const out = this.forms.filter((f) => !this.regularVerbs.has(f.parent));
    this.kortFormsCache = { forms: this.forms, size: this.regularVerbs.size, out };
    return out;
  }
  /** verb-id → alla presensformer (läsning: får förekomma i texter, blir aldrig kort) */
  lasFormer = new Map<string, string[]>();
  data: AppData = emptyData();
  attribution: string[] = [];
  /** Kursens lektioner (data/klass.json): per enhet orden den introducerar, i lektionsordning. */
  klassLektioner: { unidad: string; datum: string | null; ord: string[]; klar?: boolean }[] = [];
  /** Orden från lektioner markerade klara — det klassläget övar på. */
  klassOrd = new Set<string>();
  /** Bokens svenska där den skiljer sig från Glosas: visas i klassläget, godkänns alltid. */
  klassSv = new Map<string, string>();
  /** Anropas när lokal data ändras — synken använder den för att veta vad som ska skickas upp. */
  onDirty?: (kind: DirtyKind, key?: string) => void;

  constructor(private adapter: StorageAdapter = new LocalStorageAdapter()) {}

  private dirty(kind: DirtyKind, key?: string): void {
    this.onDirty?.(kind, key);
  }

  async loadWords(baseUrl: string): Promise<void> {
    const index = await (await fetch(`${baseUrl}data/index.json`)).json();
    const all: Word[] = [];
    for (const b of index.batches) {
      const batch = await (await fetch(`${baseUrl}data/${b.file}`)).json();
      all.push(...batch.words);
      if (batch.attribution) this.attribution = batch.attribution;
    }
    all.sort((a, b) => a.rank - b.rank);
    this.words = all;
    this.byId = new Map(all.map((w) => [w.id, w]));
    try {
      await this.loadForms(baseUrl);
    } catch { /* böjningsdata är valfri — appen funkar med bara orden */ }
    try {
      await this.loadKlass(baseUrl);
    } catch { /* klasslistan är valfri — utan den finns bara läget "allt" */ }
    // exempelmeningarna laddas i bakgrunden — facit funkar utan dem tills de kommit
    void this.loadExamples(baseUrl).catch(() => { /* valfri data */ });
  }

  private async loadExamples(baseUrl: string): Promise<void> {
    const res = await fetch(`${baseUrl}data/examples.json`);
    if (!res.ok) return;
    const json = await res.json();
    this.examples = new Map(Object.entries(json.ex as Record<string, string[]>));
  }

  /**
   * Exempelmening för ett ord eller en böjningsform (Tatoeba).
   * Tupeln är [es, sv?, en?] — engelskan är reservöversättning där svensk
   * länk saknas. Böjningar utan egen mening ärver moderverbets.
   */
  exampleFor(wordId: string): { es: string; sv?: string; en?: string } | null {
    const e = this.examples.get(wordId)
      ?? this.examples.get(this.formById.get(wordId)?.parent ?? "");
    if (!e) return null;
    return { es: e[0], sv: e[1] || undefined, en: e[2] || undefined };
  }

  private async loadKlass(baseUrl: string): Promise<void> {
    const res = await fetch(`${baseUrl}data/klass.json`);
    if (!res.ok) return;
    const json = await res.json();
    this.klassLektioner = json.lektioner ?? [];
    this.klassSv = new Map(Object.entries((json.sv ?? {}) as Record<string, string>));
    this.klassOrd = new Set(this.klassLektioner.filter((l) => l.klar)
      .flatMap((l) => l.ord.filter((id) => this.byId.has(id))));
  }

  private async loadForms(baseUrl: string): Promise<void> {
    const res = await fetch(`${baseUrl}data/verbforms.json`);
    if (!res.ok) return;
    this.setForms(await res.json());
  }

  /** Böjningsdatan (data/verbforms.json): formposterna, läslistan, regelbundna verb och extra facit. */
  setForms(json: { forms: VerbForm[]; las?: Record<string, string[]> }): void {
    this.forms = json.forms;
    this.formById = new Map(this.forms.map((f) => [f.id, f]));
    this.lasFormer = new Map(Object.entries((json.las ?? {}) as Record<string, string[]>));
    this.formsByParent = new Map();
    for (const f of this.forms) {
      if (!this.formsByParent.has(f.parent)) this.formsByParent.set(f.parent, []);
      this.formsByParent.get(f.parent)!.push(f);
    }
    const generated = this.klassaVerb();
    for (const f of generated) this.formById.set(f.id, f);
    const allForms = [...this.forms, ...generated];
    // extra godkända sv→es-svar:
    //  1. moderverbets alt-verb i samma person (elegir/escoger-paren)
    //  2. krockande sv-promptar ("jag går" → voy ELLER ando) — men bara när
    //     moderverbet saknar hint; med hint är prompten redan entydig
    const formsByParentEs = new Map<string, Map<string, string>>(); // verbets es → person → formens es
    for (const f of allForms) {
      const parentEs = this.byId.get(f.parent)?.es;
      if (!parentEs) continue;
      if (!formsByParentEs.has(parentEs)) formsByParentEs.set(parentEs, new Map());
      formsByParentEs.get(parentEs)!.set(f.person, f.es);
    }
    const byPrompt = new Map<string, VerbForm[]>();
    for (const f of allForms) {
      const key = `${PERSON_SV[f.person]} ${f.svPres}`;
      if (!byPrompt.has(key)) byPrompt.set(key, []);
      byPrompt.get(key)!.push(f);
    }
    for (const f of allForms) {
      const acc = new Set<string>();
      const parent = this.byId.get(f.parent);
      for (const altEs of parent?.alt ?? []) {
        const alt = formsByParentEs.get(altEs)?.get(f.person);
        if (alt) acc.add(alt);
      }
      if (!parent?.hint) {
        for (const other of byPrompt.get(`${PERSON_SV[f.person]} ${f.svPres}`) ?? []) {
          if (other.parent !== f.parent) acc.add(other.es);
        }
      }
      if (acc.size) f.accept = [...acc];
    }
  }

  /**
   * Regelbundet i presens = varje belagd form (läslistan + formposterna) är
   * stam + regelbunden ändelse, och jag-formen finns belagd. Jag-formen avslöjar
   * stamväxling, -zco, -go, -jo, -yo och accentflytt; saknas den räknas verbet
   * som oregelbundet och behåller sina formkort. Ger de genererade formerna.
   */
  private klassaVerb(): VerbForm[] {
    const belagt = new Map<string, Set<string>>();
    for (const [vid, fs] of this.lasFormer) belagt.set(vid, new Set(fs));
    for (const f of this.forms) {
      if (!belagt.has(f.parent)) belagt.set(f.parent, new Set());
      belagt.get(f.parent)!.add(f.es);
    }
    this.regularVerbs = new Set();
    this.varianterByParent = new Map();
    const generated: VerbForm[] = [];
    for (const [vid, fs] of belagt) {
      const inf = this.byId.get(vid)?.es ?? "";
      const andelser = ANDELSER[inf.slice(-2)];
      const poster = this.formsByParent.get(vid) ?? [];
      if (!andelser || !poster.length) continue; // utan svensk presens går inget att fråga
      const ratt = andelser.map((e) => inf.slice(0, -2) + e);
      if (!fs.has(ratt[0]) || [...fs].some((x) => !ratt.includes(x))) continue;
      this.regularVerbs.add(vid);
      const svPres = poster[0].svPres;
      this.varianterByParent.set(vid, PERSONER.map((person, i) => {
        const finns = poster.find((p) => p.person === person);
        if (finns) return finns;
        const f: VerbForm = { id: `${vid}#pres.${person}`, parent: vid, es: ratt[i], person, svPres, r: 0, slot: 0 };
        generated.push(f);
        return f;
      }));
    }
    return generated;
  }

  /** Vilande formkort: en böjning av ett regelbundet verb — kortet ligger kvar men övas inte. */
  vilande(unitId: string): boolean {
    const f = this.formById.get(unitId);
    return !!f && this.regularVerbs.has(f.parent);
  }

  /**
   * Böjningarna verbets kort kan fråga: regelbundet verb vars es→sv-kort klarats
   * minst en gång (samma upplåsning som formkorten hade). Annars infinitiven.
   */
  varianter(verbId: string): VerbForm[] {
    const v = this.varianterByParent.get(verbId);
    const pc = this.card(verbId, "es2sv");
    return v && pc && pc.fsrs.reps >= 1 && pc.fsrs.stability >= 1 ? v : [];
  }

  loadUserData(): void {
    const d = this.adapter.load();
    if (d) this.data = d;
  }

  save(): void {
    this.adapter.save(this.data);
  }

  userWord(wordId: string): UserWord {
    return this.data.userWords[wordId] ?? { syn: [], mnem: "" };
  }

  setMnem(wordId: string, mnem: string): void {
    const uw = this.userWord(wordId);
    this.data.userWords[wordId] = { ...uw, mnem: mnem.trim(), updatedAt: new Date().toISOString() };
    this.save();
    this.dirty("userWord", wordId);
  }

  addUserSyn(wordId: string, syn: string): void {
    const uw = this.userWord(wordId);
    const s = syn.trim();
    if (!s || uw.syn.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    this.data.userWords[wordId] = { ...uw, syn: [...uw.syn, s], updatedAt: new Date().toISOString() };
    this.save();
    this.dirty("userWord", wordId);
  }

  removeUserSyn(wordId: string, syn: string): void {
    const uw = this.userWord(wordId);
    this.data.userWords[wordId] = { ...uw, syn: uw.syn.filter((x) => x !== syn), updatedAt: new Date().toISOString() };
    this.save();
    this.dirty("userWord", wordId);
  }

  /** Övas inte: användaren har avstått enheten. Böjningar ärver moderverbets val. */
  /** Klassläget är på (och klasslistan finns). */
  klassLage(): boolean {
    return this.data.settings.lage === "klass" && this.klassOrd.size > 0;
  }

  /**
   * Hör enheten till dagens pass? Inte om den är avstådd, och i klassläget bara
   * klassens ord (och böjningar av dem). Korten utanför rörs inte — de vilar.
   */
  iPasset(unitId: string): boolean {
    if (this.avstadd(unitId) || this.vilande(unitId)) return false;
    if (!this.klassLage()) return true;
    return this.klassOrd.has(unitId) || this.klassOrd.has(this.formById.get(unitId)?.parent ?? "");
  }

  avstadd(unitId: string): boolean {
    if (this.userWord(unitId).skip) return true;
    const f = this.formById.get(unitId);
    return !!f && !!this.userWord(f.parent).skip;
  }

  /** "Öva inte på det här ordet mer" (och ångra). Historiken och korten rörs inte. */
  setAvstadd(unitId: string, on: boolean): void {
    const uw = this.userWord(unitId);
    if (!!uw.skip === on) return;
    this.data.userWords[unitId] = { ...uw, skip: on, updatedAt: new Date().toISOString() };
    this.save();
    this.dirty("userWord", unitId);
  }

  setNewFirst(v: number): void {
    this.data.settings.newFirst = v;
    this.data.settings.updatedAt = new Date().toISOString();
    this.save();
    this.dirty("settings");
  }

  setNewMore(v: number): void {
    this.data.settings.newMore = v;
    this.data.settings.updatedAt = new Date().toISOString();
    this.save();
    this.dirty("settings");
  }

  /** Facittempo — lokala inställningar (ingen molnkolumn, ingen migrering). */
  setAutoNext(on: boolean): void {
    this.data.settings.autoNext = on;
    this.save();
  }

  /** Ambitionsnivån — lokal inställning precis som facittempot. */
  setNiva(n: Niva): void {
    this.data.settings.niva = n;
    this.save();
  }

  setLage(l: Lage): void {
    this.data.settings.lage = l;
    this.save();
  }

  setAutoMs(ms: number): void {
    this.data.settings.autoMs = Math.max(1000, Math.min(10_000, ms));
    this.save();
  }

  /** Facit + synonymer i svarsriktningen (huvudöversättning först). */
  targets(word: Word, dir: Dir): string[] {
    const uw = this.userWord(word.id);
    if (dir === "es2sv") {
      const k = this.klassSv.get(word.id);
      const base = [word.sv, ...word.syn, ...(k && k !== word.sv ? [k] : []), ...uw.syn];
      // substantiv: "la verdad" i prompten lockar fram "sanningen" —
      // bestämda former accepteras (aldrig visade, bara godkända)
      if (word.pos === "n") return [...base, ...base.flatMap(svBestamd)];
      return base;
    }
    // sv→es: det spanska ordet + äkta synonymer (empezar/comenzar) + egna tillägg;
    // artiklar och accenter sköts av normaliseringen
    return [word.es, ...(word.alt ?? []), ...uw.syn];
  }

  /**
   * Facit för ett kort — hanterar både ord och böjningsformer. `variant` är
   * böjningen passet valt för ett regelbundet verbs kort.
   */
  targetsFor(card: CardRec, variant?: VerbForm): string[] {
    const form = variant ?? this.formById.get(card.wordId);
    if (form) {
      // egna synonymer ("jag hade rätt") bor på FORMENS id — inte moderverbets
      const uw = this.userWord(form.id);
      // es→sv: alla pronomenvarianter är facit ("han är" OCH "hon är"), blotta verbet
      // också — och moderverbets glosor i böjd form ("jag passerar" för paso, vars
      // huvudglosa är "händer"): synonymer ska gälla även på formkorten
      if (card.dir === "es2sv") {
        const parent = this.byId.get(form.parent);
        const synBojda = [parent?.sv ?? "", ...(parent?.syn ?? [])]
          .filter(Boolean)
          .flatMap(svBojda);
        return [
          ...PERSON_SV_SVAR[form.person].map((p) => `${p} ${form.svPres}`),
          form.svPres,
          ...PERSON_SV_SVAR[form.person].flatMap((p) => synBojda.map((b) => `${p} ${b}`)),
          ...synBojda,
          ...uw.syn,
        ];
      }
      return [form.es, ...(form.accept ?? []), ...uw.syn];
    }
    return this.targets(this.wordFor(card), card.dir);
  }

  /**
   * Moderordet för ett kort (formkort → föräldern, vanliga kort → ordet självt).
   * I klassläget med bokens svenska som huvudsvar; Glosas blir synonym.
   */
  wordFor(card: CardRec): Word {
    const form = this.formById.get(card.wordId);
    const w = this.byId.get(form ? form.parent : card.wordId);
    if (!w) throw new Error(`okänt ord: ${card.wordId}`);
    const k = this.klassLage() ? this.klassSv.get(w.id) : undefined;
    if (!k || k === w.sv) return w;
    return { ...w, sv: k, syn: [w.sv, ...w.syn.filter((x) => x !== k)] };
  }

  formFor(card: CardRec): VerbForm | undefined {
    return this.formById.get(card.wordId);
  }

  card(wordId: string, dir: Dir): CardRec | undefined {
    return this.data.cards[cardKey(wordId, dir)];
  }

  putCard(rec: CardRec): void {
    rec.updatedAt = new Date().toISOString();
    this.data.cards[cardKey(rec.wordId, rec.dir)] = rec;
    this.dirty("card", cardKey(rec.wordId, rec.dir));
  }

  /** Förfallna kort (due ≤ slutet av idag), äldst först. Bara kort i passet (se iPasset). */
  dueCards(now: Date = new Date()): CardRec[] {
    const cutoff = endOfToday(now).getTime();
    return Object.values(this.data.cards)
      .filter((c) => dueDate(c).getTime() <= cutoff && this.iPasset(c.wordId))
      .sort((a, b) => dueDate(a).getTime() - dueDate(b).getTime());
  }

  /**
   * Antal ord introducerade under dagens lokala kalenderdag — härlett ur korten
   * (introducedAt), inte ur en lokal räknare, så att flera enheter delar samma
   * dagsbudget efter synk.
   */
  introducedToday(now: Date = new Date()): number {
    const day = dayKey(now);
    let n = 0;
    for (const key in this.data.cards) {
      const c = this.data.cards[key];
      if (c.dir === "es2sv" && dayKey(new Date(c.introducedAt)) === day) n++;
    }
    return n;
  }

  /** Är böjningen upplåst? Moderverbets es→sv-kort ska ha klarats minst en gång. */
  private formUnlocked(f: VerbForm): boolean {
    const pc = this.card(f.parent, "es2sv");
    return !!pc && pc.fsrs.reps >= 1 && pc.fsrs.stability >= 1;
  }

  /** Lyssna-kursens boost: ordId:n ur spelade lektioner introduceras före frekvenskön. */
  private lyssnaPrio: string[] = [];
  setLyssnaPrio(ids: string[]): void {
    this.lyssnaPrio = ids;
  }

  /**
   * Nästa `count` enheter ur den förenade introduktionskön: lyssna-boostade
   * ord först (lektioner du spelat), sedan nya ord i frekvensordning,
   * upplåsta böjningar via sin korpus-slot (tengo slår de flesta substantiv).
   * Max en ny form per verb och dag. Ändrar ingenting.
   */
  nextIntroUnits(count: number, now: Date = new Date()): IntroUnit[] {
    if (count <= 0) return [];
    // klassläget tar inga nya ord ur kön: klassens ord kommer in när lektionen markeras gjord
    if (this.klassLage()) return [];
    const day = dayKey(now);
    const parentToday = new Set<string>();
    for (const key in this.data.cards) {
      const c = this.data.cards[key];
      if (c.dir !== "es2sv") continue;
      const form = this.formById.get(c.wordId);
      if (form && dayKey(new Date(c.introducedAt)) === day) parentToday.add(form.parent);
    }
    const formQueue = this.kortForms
      .filter((f) => !this.card(f.id, "es2sv") && this.formUnlocked(f) &&
                     !parentToday.has(f.parent) && !this.avstadd(f.id))
      .sort((a, b) => a.slot - b.slot || a.r - b.r);
    const prioQueue = this.lyssnaPrio
      .map((id) => this.byId.get(id))
      .filter((w): w is Word => w !== undefined);
    const out: IntroUnit[] = [];
    const picked = new Set<string>();
    // avstådda ord introduceras aldrig — kön går vidare till nästa
    const upptagen = (id: string) => !!this.card(id, "es2sv") || picked.has(id) || this.avstadd(id);
    let fi = 0, wi = 0, pi = 0;
    while (out.length < count) {
      while (pi < prioQueue.length && upptagen(prioQueue[pi].id)) pi++;
      while (wi < this.words.length && upptagen(this.words[wi].id)) wi++;
      while (fi < formQueue.length && parentToday.has(formQueue[fi].parent)) fi++;
      const nf = formQueue[fi];
      const boost = pi < prioQueue.length;
      const nw = boost ? prioQueue[pi] : this.words[wi];
      // boostade ord går före böjningsformer — de kommer ur en lektion du nyss hört
      const nwRank = boost ? 0 : nw?.rank;
      if (!nf && !nw) break;
      if (nf && (!nw || nf.slot <= nwRank!)) {
        out.push({ kind: "form", form: nf });
        parentToday.add(nf.parent); // max 1 per verb även inom samma omgång
        fi++;
      } else {
        out.push({ kind: "word", word: nw! });
        picked.add(nw!.id);
        if (boost) pi++; else wi++;
      }
    }
    return out;
  }

  /** Introducerar `count` enheter (två kort vardera; es→sv-korten först i kön). */
  introduceUnits(count: number, now: Date = new Date()): CardRec[] {
    const units = this.nextIntroUnits(count, now);
    const first: CardRec[] = [];
    const second: CardRec[] = [];
    for (const u of units) {
      const id = u.kind === "word" ? u.word.id : u.form.id;
      first.push(newCardRec(id, "es2sv", now));
      second.push(newCardRec(id, "sv2es", new Date(now.getTime() + 1)));
    }
    const fresh = [...first, ...second];
    for (const c of fresh) this.putCard(c);
    if (fresh.length) this.save();
    return fresh;
  }

  /** Har någon repetition loggats idag? Styr "dagens övning" kontra "öva mer". */
  firstToday(now: Date = new Date()): boolean {
    return (this.data.days[dayKey(now)] ?? 0) === 0;
  }

  /** Antal kort med förfall inom `days` dagar — prognosens baslinje tas FÖRE introduktion. */
  dueSoonCount(days = 7, now: Date = new Date()): number {
    const cutoff = now.getTime() + days * 24 * 3600 * 1000;
    let n = 0;
    for (const key in this.data.cards) {
      const c = this.data.cards[key];
      if (dueDate(c).getTime() <= cutoff && this.iPasset(c.wordId)) n++;
    }
    return n;
  }

  /** Introducerade men aldrig besvarade enheter som väntar i dagens kö. */
  unseenCount(now: Date = new Date()): number {
    const cutoff = endOfToday(now).getTime();
    let n = 0;
    for (const key in this.data.cards) {
      const c = this.data.cards[key];
      if (c.dir === "es2sv" && c.fsrs.reps === 0 && dueDate(c).getTime() <= cutoff &&
          this.iPasset(c.wordId)) n++;
    }
    return n;
  }

  /** Nivåns dagsbudget (nya ord). */
  nivaConf(): { nya: number } {
    return NIVAER[this.data.settings.niva ?? "lagom"];
  }

  /** Nya ord kvar i dagens budget — introduktioner räknas ur korten (delas mellan enheter). */
  budgetKvar(now: Date = new Date()): number {
    return Math.max(0, this.nivaConf().nya - this.introducedToday(now));
  }

  /**
   * Dagens portion — motorn väljer, användaren trycker bara Öva:
   *   1. förfallna repetitioner, mest kritiska först (försening i förhållande
   *      till stabiliteten: ett färskt kort tål inte att vänta, ett gammalt gör det)
   *   2. ärvda osedda kort (introducerade men aldrig besvarade)
   *   3. nya ord (2 kort/ord) — bara när ingen repskuld väntar utanför portionen
   *      och dagsbudgeten har utrymme
   *   4. repetition i förväg (närmast förfall) så knappen aldrig är död
   * Ändrar ingenting — `startPortion` gör själva introduktionen.
   */
  portionsPlan(now: Date = new Date()): PortionsPlan {
    const cutoff = endOfToday(now).getTime();
    const alla = Object.values(this.data.cards).filter((c) => this.iPasset(c.wordId));
    const kritik = (c: CardRec) =>
      (now.getTime() - dueDate(c).getTime()) / Math.max(c.fsrs.stability, 0.1);
    const rep = alla
      .filter((c) => c.fsrs.reps > 0 && dueDate(c).getTime() <= cutoff)
      .sort((a, b) => kritik(b) - kritik(a));
    const unseen = alla
      .filter((c) => c.fsrs.reps === 0 && dueDate(c).getTime() <= cutoff)
      .sort((a, b) =>
        a.dir === b.dir ? (a.introducedAt < b.introducedAt ? -1 : 1) : a.dir === "es2sv" ? -1 : 1);
    // ett rätt är ett rätt: ett ord frågas åt ett håll per dag (andra hållet en
    // annan dag), och ett oregelbundet verb ger högst en böjning per dag — resten
    // väntar till kommande dagar i stället för att komma om och om igen
    const { formPerVerb, ovat } = this.dagensOvning(now);
    const valda = new Set<string>();
    const enPerVerb = (c: CardRec): boolean => {
      if (ovat.has(c.wordId) || valda.has(c.wordId)) return false;
      const f = this.formById.get(c.wordId);
      if (f) {
        const vald = formPerVerb.get(f.parent);
        if (vald && vald !== c.wordId) return false;
        formPerVerb.set(f.parent, c.wordId);
      }
      valda.add(c.wordId);
      return true;
    };
    const repEn = rep.filter(enPerVerb);
    const unseenEn = unseen.filter(enPerVerb);
    const nyaUnits = this.nextIntroUnits(this.budgetKvar(now), now);
    const nyaOrd = new Set(unseenEn.map((c) => c.wordId)).size + nyaUnits.length;
    return {
      rep: repEn, unseen: unseenEn, nyaUnits, nyaOrd,
      repKort: repEn.length,
      totalKort: repEn.length + unseenEn.length + nyaUnits.length * 2,
    };
  }

  /** Det som redan övats idag: enheter (ord/former) och per verb den böjning som tagits. */
  private dagensOvning(now: Date): { formPerVerb: Map<string, string>; ovat: Set<string> } {
    const idag = dayKey(now);
    const formPerVerb = new Map<string, string>();
    const ovat = new Set<string>();
    for (const key in this.data.cards) {
      const c = this.data.cards[key];
      if (!c.fsrs.last_review || dayKey(new Date(c.fsrs.last_review)) !== idag) continue;
      ovat.add(c.wordId);
      const f = this.formById.get(c.wordId);
      if (f) formPerVerb.set(f.parent, c.wordId);
    }
    return { formPerVerb, ovat };
  }

  /**
   * Dagens kö: allt förfallet, mest kritiskt först, sedan ärvda nya. Nya ord ur
   * kön introduceras först när inget förfallet är kvar — passet hämtar dem
   * själv när kön tar slut (Session), så man aldrig lägger till ovanpå en skuld.
   */
  startPortion(now: Date = new Date()): CardRec[] {
    const plan = this.portionsPlan(now);
    if (plan.rep.length || plan.unseen.length) return [...plan.rep, ...plan.unseen];
    if (!plan.nyaUnits.length) return [];
    // nya ord får båda korten, men frågas åt ett håll idag (es→sv) — andra hållet en annan dag
    this.introduceUnits(plan.nyaUnits.length, now);
    const ny = this.portionsPlan(now);
    return [...ny.rep, ...ny.unseen];
  }

  /** Dagens glosor klara? Inget kvar i dagens kö och nya-budgeten använd → läsövning förvald. */
  glosorKlara(now: Date = new Date()): boolean {
    const p = this.portionsPlan(now);
    return p.rep.length === 0 && p.unseen.length === 0 && p.nyaUnits.length === 0;
  }

  /** Budgetåterbäring vid fast-track: en extra enhet, utanför övningsmålet. */
  introduceExtra(now: Date = new Date()): CardRec[] {
    return this.introduceUnits(1, now);
  }

  logReview(rec: ReviewRec): void {
    this.data.reviews.push(rec);
    const day = dayKey(new Date(rec.ts));
    this.data.days[day] = (this.data.days[day] ?? 0) + 1;
    if (rec.grade !== "again") this.data.ratt[day] = (this.data.ratt[day] ?? 0) + 1;
    this.dirty("review");
  }

  wordStatus(word: Word): WordStatus {
    const cards = [this.card(word.id, "es2sv"), this.card(word.id, "sv2es")]
      .filter((c): c is CardRec => !!c);
    if (cards.length === 0) return { word, cards, status: "ny", minStability: 0, level: "ny" };
    const minStability = Math.min(...cards.map((c) => c.fsrs.stability));
    const status = cards.length === 2 && cards.every(isKnown) ? "kan" : "lar";
    return { word, cards, status, minStability, level: this.levelFromCards(cards) };
  }

  /** Samma nivåregler för ord och böjningsformer — korten avgör. */
  private levelFromCards(cards: CardRec[]): Level {
    if (cards.length === 0) return "ny";
    // "ny" = inte mött än — gäller även introducerade men obesvarade (och nollställda)
    if (cards.every((c) => c.fsrs.reps === 0)) return "ny";
    if (cards.length === 2 && cards.every(isKnown)) return "kan";
    return Math.min(...cards.map((c) => c.fsrs.stability)) >= 7 ? "pagang" : "ovar";
  }

  /** Nivå för en böjningsform — formkorten räknas i poängen precis som ord. */
  formLevel(f: VerbForm): Level {
    return this.levelFromCards(
      [this.card(f.id, "es2sv"), this.card(f.id, "sv2es")].filter((c): c is CardRec => !!c),
    );
  }

  /** Ögonblicksbild av ordets båda kort (null = kortet finns inte) — för ångra. */
  cardSnapshot(wordId: string): (CardRec | null)[] {
    return (["es2sv", "sv2es"] as Dir[]).map((d) => {
      const c = this.card(wordId, d);
      return c ? { ...c, fsrs: { ...c.fsrs } } : null;
    });
  }

  /** Återställ korten till en ögonblicksbild (snabbmarkeringens ångra). */
  restoreCards(wordId: string, snap: (CardRec | null)[]): void {
    (["es2sv", "sv2es"] as Dir[]).forEach((d, i) => {
      const s = snap[i];
      if (s) this.putCard({ ...s, fsrs: { ...s.fsrs } });
      // fanns inget kort före: ta bort igen (osynkat lokalt är det helt rent;
      // hann det synkas återuppstår ett orört kort — som ändå visas som Ny)
      else delete this.data.cards[cardKey(wordId, d)];
    });
    this.save();
  }

  /**
   * Nivåstegen: flytta ett ord för hand. Markeringen är ärlig mot FSRS —
   * "på gång"/"kan det" sätter stabilitet (14/30 d) och kollas när kortet
   * förfaller; "övar" lägger ordet i dagens pass; "ny" börjar om från noll.
   */
  setLevel(wordId: string, level: Level, now: Date = new Date()): void {
    // flyttar man ett avstått ord på stegen vill man uppenbart ha tillbaka det
    if (this.userWord(wordId).skip) this.setAvstadd(wordId, false);
    const dirs: Dir[] = ["es2sv", "sv2es"];
    if (level === "ny" && dirs.every((d) => !this.card(wordId, d))) return; // redan orört
    for (const dir of dirs) {
      const cur = this.card(wordId, dir);
      if (level === "ny") {
        // färskt orört kort, förfallet nu — ordet kommer som nytt i passet
        this.putCard(newCardRec(wordId, dir, now));
      } else if (level === "ovar") {
        const base = cur ?? newCardRec(wordId, dir, now);
        this.putCard({
          ...base,
          fsrs: {
            ...base.fsrs,
            due: now.toISOString(),
            // in i övar-bandet — men sänk aldrig något som redan är kort
            stability: Math.min(base.fsrs.stability, 3),
          },
        });
      } else {
        this.putCard(levelCardRec(cur, wordId, dir, level === "kan" ? KNOWN_STABILITY_DAYS : 14, now));
      }
    }
    this.save();
  }

  stats() {
    // poängen räknas på NIVÅN: ny = inget svar än; lar = på väg (minst ett svar);
    // kan = sitter. Introducerade men obesvarade ord ger ingen poäng.
    // Avstådda enheter står helt utanför — varken poäng eller mål.
    let ny = 0, lar = 0, kan = 0, avstadda = 0;
    for (const w of this.words) {
      if (this.avstadd(w.id)) { avstadda++; continue; }
      const lvl = this.wordStatus(w).level;
      if (lvl === "ny") ny++;
      else if (lvl === "kan") kan++;
      else lar++;
    }
    // böjningsformerna är fullvärdiga poäng — samma nivåregler som orden
    // regelbundna verbs böjningar är ingen egen enhet — verbet räknas en gång
    for (const f of this.kortForms) {
      if (this.avstadd(f.id)) { avstadda++; continue; }
      const lvl = this.formLevel(f);
      if (lvl === "ny") ny++;
      else if (lvl === "kan") kan++;
      else lar++;
    }
    const total = this.words.length + this.kortForms.length - avstadda;
    return {
      ny, lar, kan,
      score: kan + lar, // nivåresans poäng — orden man kan + orden på väg
      started: lar + kan,
      total,
      goal: total, // hela basen: ord + böjningsformer, minus avstådda
    };
  }

  /** Dagens statussnapshot för grafen (skrivs vid appstart och efter pass). */
  snapshotToday(now: Date = new Date()): void {
    const { kan, lar } = this.stats();
    this.data.snapshots[dayKey(now)] = { kan, lar };
    this.save();
    this.dirty("snapshot", dayKey(now));
  }
}
