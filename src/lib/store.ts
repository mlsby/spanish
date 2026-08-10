import type { AppData, CardRec, Dir, DirtyKind, Level, ReviewRec, UserWord, VerbForm, Word } from "./types";
import { cardKey, PERSON_SV, PERSON_SV_SVAR } from "./types";
import { dueDate, isKnown, levelCardRec, newCardRec } from "./scheduler";
import { emptyData, LocalStorageAdapter, type StorageAdapter } from "./storage";
import { dayKey, endOfToday } from "./time";

/** Nästa enhet i introduktionskön: ett nytt ord eller en upplåst verbböjning. */
export type IntroUnit = { kind: "word"; word: Word } | { kind: "form"; form: VerbForm };

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
  formsByParent = new Map<string, VerbForm[]>();
  data: AppData = emptyData();
  attribution: string[] = [];
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
  }

  private async loadForms(baseUrl: string): Promise<void> {
    const res = await fetch(`${baseUrl}data/verbforms.json`);
    if (!res.ok) return;
    const json = await res.json();
    this.forms = json.forms as VerbForm[];
    this.formById = new Map(this.forms.map((f) => [f.id, f]));
    this.formsByParent = new Map();
    const byEs = new Map<string, VerbForm[]>();
    for (const f of this.forms) {
      if (!this.formsByParent.has(f.parent)) this.formsByParent.set(f.parent, []);
      this.formsByParent.get(f.parent)!.push(f);
      if (!byEs.has(f.es)) byEs.set(f.es, []);
      byEs.get(f.es)!.push(f);
    }
    // extra godkända sv→es-svar:
    //  1. moderverbets alt-verb i samma person (elegir/escoger-paren)
    //  2. krockande sv-promptar ("jag går" → voy ELLER ando) — men bara när
    //     moderverbet saknar hint; med hint är prompten redan entydig
    const formsByParentEs = new Map<string, Map<string, string>>(); // verbets es → person → formens es
    for (const f of this.forms) {
      const parentEs = this.byId.get(f.parent)?.es;
      if (!parentEs) continue;
      if (!formsByParentEs.has(parentEs)) formsByParentEs.set(parentEs, new Map());
      formsByParentEs.get(parentEs)!.set(f.person, f.es);
    }
    const byPrompt = new Map<string, VerbForm[]>();
    for (const f of this.forms) {
      const key = `${PERSON_SV[f.person]} ${f.svPres}`;
      if (!byPrompt.has(key)) byPrompt.set(key, []);
      byPrompt.get(key)!.push(f);
    }
    for (const f of this.forms) {
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

  setPace(v: number): void {
    this.data.settings.newPerDay = v;
    this.data.settings.updatedAt = new Date().toISOString();
    this.save();
    this.dirty("settings");
  }

  /** Facit + synonymer i svarsriktningen (huvudöversättning först). */
  targets(word: Word, dir: Dir): string[] {
    const uw = this.userWord(word.id);
    if (dir === "es2sv") return [word.sv, ...word.syn, ...uw.syn];
    // sv→es: det spanska ordet + äkta synonymer (empezar/comenzar) + egna tillägg;
    // artiklar och accenter sköts av normaliseringen
    return [word.es, ...(word.alt ?? []), ...uw.syn];
  }

  /** Facit för ett kort — hanterar både ord och böjningsformer. */
  targetsFor(card: CardRec): string[] {
    const form = this.formById.get(card.wordId);
    if (form) {
      // egna synonymer ("jag hade rätt") bor på FORMENS id — inte moderverbets
      const uw = this.userWord(card.wordId);
      // es→sv: alla pronomenvarianter är facit ("han är" OCH "hon är"), blotta verbet också
      if (card.dir === "es2sv") {
        return [
          ...PERSON_SV_SVAR[form.person].map((p) => `${p} ${form.svPres}`),
          form.svPres,
          ...uw.syn,
        ];
      }
      return [form.es, ...(form.accept ?? []), ...uw.syn];
    }
    return this.targets(this.wordFor(card), card.dir);
  }

  /** Moderordet för ett kort (formkort → föräldern, vanliga kort → ordet självt). */
  wordFor(card: CardRec): Word {
    const form = this.formById.get(card.wordId);
    const w = this.byId.get(form ? form.parent : card.wordId);
    if (!w) throw new Error(`okänt ord: ${card.wordId}`);
    return w;
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

  /** Förfallna kort (due ≤ slutet av idag), äldst först. */
  dueCards(now: Date = new Date()): CardRec[] {
    const cutoff = endOfToday(now).getTime();
    return Object.values(this.data.cards)
      .filter((c) => dueDate(c).getTime() <= cutoff)
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

  /**
   * Nästa `count` enheter ur den förenade introduktionskön: nya ord i
   * frekvensordning, upplåsta böjningar via sin korpus-slot (tengo slår de
   * flesta substantiv). Max en ny form per verb och dag. Ändrar ingenting.
   */
  nextIntroUnits(count: number, now: Date = new Date()): IntroUnit[] {
    if (count <= 0) return [];
    const day = dayKey(now);
    const parentToday = new Set<string>();
    for (const key in this.data.cards) {
      const c = this.data.cards[key];
      if (c.dir !== "es2sv") continue;
      const form = this.formById.get(c.wordId);
      if (form && dayKey(new Date(c.introducedAt)) === day) parentToday.add(form.parent);
    }
    const formQueue = this.forms
      .filter((f) => !this.card(f.id, "es2sv") && this.formUnlocked(f) && !parentToday.has(f.parent))
      .sort((a, b) => a.slot - b.slot || a.r - b.r);
    const out: IntroUnit[] = [];
    let fi = 0, wi = 0;
    while (out.length < count) {
      while (wi < this.words.length && this.card(this.words[wi].id, "es2sv")) wi++;
      while (fi < formQueue.length && parentToday.has(formQueue[fi].parent)) fi++;
      const nf = formQueue[fi];
      const nw = this.words[wi];
      if (!nf && !nw) break;
      if (nf && (!nw || nf.slot <= nw.rank)) {
        out.push({ kind: "form", form: nf });
        parentToday.add(nf.parent); // max 1 per verb även inom samma omgång
        fi++;
      } else {
        out.push({ kind: "word", word: nw });
        wi++;
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

  /** Introducerar dagens nya enheter (upp till dagstakten). Idempotent per dag. */
  introduceToday(now: Date = new Date()): CardRec[] {
    const room = Math.max(0, this.data.settings.newPerDay - this.introducedToday(now));
    return this.introduceUnits(room, now);
  }

  /**
   * Bonus: n extra enheter utanför dagstaktens rumskoll. introducedToday()
   * räknar per kalenderdag, så morgondagens kvot påverkas inte.
   */
  introduceBonus(n: number, now: Date = new Date()): CardRec[] {
    return this.introduceUnits(n, now);
  }

  /** Budgetåterbäring vid fast-track: en extra enhet, utanför dagstakten. */
  introduceExtra(now: Date = new Date()): CardRec[] {
    return this.introduceUnits(1, now);
  }

  logReview(rec: ReviewRec): void {
    this.data.reviews.push(rec);
    const day = dayKey(new Date(rec.ts));
    this.data.days[day] = (this.data.days[day] ?? 0) + 1;
    this.dirty("review");
  }

  wordStatus(word: Word): WordStatus {
    const cards = [this.card(word.id, "es2sv"), this.card(word.id, "sv2es")]
      .filter((c): c is CardRec => !!c);
    if (cards.length === 0) return { word, cards, status: "ny", minStability: 0, level: "ny" };
    const minStability = Math.min(...cards.map((c) => c.fsrs.stability));
    const status = cards.length === 2 && cards.every(isKnown) ? "kan" : "lar";
    // "ny" = inte mött än — gäller även introducerade men obesvarade (och nollställda) ord
    const level: Level = cards.every((c) => c.fsrs.reps === 0) ? "ny"
      : status === "kan" ? "kan"
      : minStability >= 7 ? "pagang" : "ovar";
    return { word, cards, status, minStability, level };
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
        this.putCard(levelCardRec(cur, wordId, dir, level === "kan" ? 30 : 14, now));
      }
    }
    this.save();
  }

  stats(now: Date = new Date()) {
    let ny = 0, lar = 0, kan = 0;
    for (const w of this.words) {
      const s = this.wordStatus(w).status;
      if (s === "ny") ny++;
      else if (s === "lar") lar++;
      else kan++;
    }
    const newLeftToday = Math.max(0, this.data.settings.newPerDay - this.introducedToday(now));
    const newAvailable = newLeftToday > 0 ? this.nextIntroUnits(newLeftToday, now).length : 0;
    return {
      ny, lar, kan,
      started: lar + kan,
      total: this.words.length,
      goal: 5000,
      due: this.dueCards(now).length,
      newAvailable,
    };
  }

  /** Dagens statussnapshot för grafen (skrivs vid appstart och efter pass). */
  snapshotToday(now: Date = new Date()): void {
    const { kan, lar } = this.stats(now);
    this.data.snapshots[dayKey(now)] = { kan, lar };
    this.save();
    this.dirty("snapshot", dayKey(now));
  }
}
