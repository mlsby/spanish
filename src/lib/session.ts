import { gradeAnswer, normalize, type GradeResult } from "./grading";
import { insertSpaced, spaceSiblings } from "./queue";
import { applyReview, dueDate } from "./scheduler";
import type { Store } from "./store";
import { endOfToday } from "./time";
import { cardKey, type CardRec, type Dir, type Grade, type Step, type VerbForm, type Word } from "./types";

export interface Pending {
  card: CardRec;
  word: Word;              // moderordet (för formkort: föräldern)
  form?: VerbForm;         // satt när kortet är en verbböjning
  raw: string;
  grade: Grade;
  step: Step;
  matched?: string;
  /** allra första visningen av kortet — styr fast-track och "kan redan" */
  firstExposure: boolean;
  /** schemaläggs som FSRS Easy (förkunskaps-fast-track) */
  easy: boolean;
  /** blir detta fel nr 2+ på kortet? → minnesregel obligatorisk */
  forcedMnem: boolean;
}

export interface SessionCounts { good: number; hard: number; again: number }

/** Serialiserat pågående pass — så en avbruten övning kan fortsättas. */
export interface SessionState {
  queue: [string, Dir][];
  done: number;
  counts: SessionCounts;
  baseline: number;
}

/**
 * Ett kort besvaras en gång per dag. Fel svar får ett enda nytt försök, så här
 * många kort senare (eller sist om kön är kortare) — sedan är kortet klart för idag.
 */
const RETRY_GAP = 10;
/** Syskonuppskov: klaras första riktningen exakt väntar andra riktningen ~2 veckor. */
const SIBLING_DEFER_MS = 14 * 24 * 3600 * 1000;
/** Budgetåterbäringens tak: max 3× första övningens takt i introduktioner per dag. */
const REFUND_CAP_FACTOR = 3;

export class Session {
  queue: CardRec[] = [];
  done = 0;
  counts: SessionCounts = { good: 0, hard: 0, again: 0 };
  pending: Pending | null = null;
  /** kort med due inom 7 dagar vid sessionsstart — för prognosraden */
  private dueSoonBaseline = 0;
  /** kort som redan fått sitt enda nya försök efter fel svar */
  private retried = new Set<string>();
  /** böjningen som valts för ett regelbundet verbs kort — fast tills kortet besvarats */
  private valdForm = new Map<string, VerbForm>();
  /** senast frågade person per kort — nytt försök slår om till en annan */
  private senastePerson = new Map<string, VerbForm["person"]>();
  private rand: () => number;

  constructor(
    private store: Store, cards: CardRec[],
    opts?: { dueSoonBaseline?: number; rand?: () => number },
  ) {
    // syskonkort (samma ord/moderverb) hålls isär så facit aldrig står kvar på skärmen
    this.queue = spaceSiblings(cards);
    // baslinjen tas helst FÖRE introduktionen — annars räknas dagens nya inte in
    this.dueSoonBaseline = opts?.dueSoonBaseline ?? this.store.dueSoonCount();
    this.rand = opts?.rand ?? Math.random;
  }

  /**
   * Böjningen kortet frågar: formkortets egen, eller för ett regelbundet verb en
   * slumpad person (vald en gång och fast tills kortet besvarats). Annars ingen.
   */
  formFor(card: CardRec): VerbForm | undefined {
    const egen = this.store.formFor(card);
    if (egen) return egen;
    const key = cardKey(card.wordId, card.dir);
    const vald = this.valdForm.get(key);
    if (vald) return vald;
    const forra = this.senastePerson.get(key);
    // har passet redan frågat en böjning hålls det kvar vid nytt försök, även om
    // felet sänkte verbets stabilitet under upplåsningen
    const alla = forra
      ? this.store.varianterByParent.get(card.wordId) ?? []
      : this.store.varianter(card.wordId);
    if (!alla.length) return undefined;
    const val = alla.length > 1 ? alla.filter((f) => f.person !== forra) : alla;
    const f = val[Math.floor(this.rand() * val.length) % val.length];
    this.valdForm.set(key, f);
    this.senastePerson.set(key, f.person);
    return f;
  }

  /** Ögonblicksbild av passet — det som behövs för att fortsätta senare. */
  snapshot(): SessionState {
    return {
      queue: this.queue.map((c) => [c.wordId, c.dir]),
      done: this.done,
      counts: { ...this.counts },
      baseline: this.dueSoonBaseline,
    };
  }

  /**
   * Återuppta ett avbrutet pass: kön byggs om från färska kort (FSRS-läget kan
   * ha ändrats under pausen — t.ex. ✓-markerade ord som inte längre förfaller
   * idag hoppar av), räknare och prognosbaslinje följer med.
   */
  static restore(store: Store, state: SessionState, now: Date = new Date()): Session {
    const cutoff = endOfToday(now).getTime();
    const cards: CardRec[] = [];
    for (const [wordId, dir] of state.queue) {
      const c = store.card(wordId, dir);
      if (c && dueDate(c).getTime() <= cutoff && store.iPasset(wordId)) cards.push(c);
    }
    const s = new Session(store, [], { dueSoonBaseline: state.baseline });
    s.queue = cards; // behåll passets ordning — den var redan syskonavståndad
    s.done = state.done;
    s.counts = { ...state.counts };
    return s;
  }

  get current(): CardRec | null {
    return this.queue[0] ?? null;
  }

  get finished(): boolean {
    return this.queue.length === 0;
  }

  word(card: CardRec): Word {
    return this.store.wordFor(card);
  }

  answerLang(dir: Dir): "sv" | "es" {
    return dir === "es2sv" ? "sv" : "es";
  }

  /** Rätta svaret (steg 1–2). Ingenting sparas förrän commit(). */
  answer(raw: string): Pending {
    const card = this.current;
    if (!card) throw new Error("inget aktuellt kort");
    const word = this.word(card);
    const form = this.formFor(card);
    const targets = this.store.targetsFor(card, form);
    const r: GradeResult = gradeAnswer(raw, targets, this.answerLang(card.dir));
    const firstExposure = card.fsrs.reps === 0;
    this.pending = {
      card, word, form, raw: raw.trim(),
      grade: r.grade, step: r.step, matched: r.matched,
      firstExposure,
      // förkunskaps-fast-track: helt rätt vid allra första mötet ⇒ Easy
      easy: firstExposure && r.grade === "good",
      forcedMnem: r.grade === "again" && card.failCount + 1 >= 2,
    };
    return this.pending;
  }

  /** "Jag hade rätt": svaret sparas som synonym, betyget uppgraderas till hard, override loggas. */
  override(): Pending {
    if (!this.pending) throw new Error("inget att skriva över");
    const p = this.pending;
    const lang = this.answerLang(p.card.dir);
    const norm = normalize(p.raw, lang);
    // böjning: synonymen hör till just den formen (formens id), inte moderverbet —
    // annars läses den aldrig vid nästa rättning
    if (norm) this.store.addUserSyn(p.form ? p.form.id : p.word.id, norm);
    this.pending = { ...p, grade: "hard", step: "override", forcedMnem: false };
    return this.pending;
  }

  /**
   * "Kan redan — bara stavfel": vid första mötet + fuzzy-rätt uppgraderas
   * betyget till good/Easy. Claimet är förankrat i bevis — man träffade nästan.
   */
  claimKnown(): Pending {
    if (!this.pending) throw new Error("inget att uppgradera");
    const p = this.pending;
    if (!p.firstExposure || p.grade !== "hard") return p;
    this.pending = { ...p, grade: "good", step: "override", easy: true };
    return this.pending;
  }

  /**
   * "Öva inte på det här ordet mer": inget betyg loggas, enheten flaggas som
   * avstådd och alla dess kort (för moderverb även böjningarnas) lämnar kön.
   */
  avsta(): void {
    const card = this.pending?.card ?? this.current;
    if (!card) return;
    this.pending = null;
    this.store.setAvstadd(card.wordId, true);
    this.queue = this.queue.filter(
      (c) => c.wordId !== card.wordId && this.store.formFor(c)?.parent !== card.wordId,
    );
  }

  /**
   * Bekräfta utfallet: FSRS uppdateras, reviewloggen skrivs, kortet lämnar kön.
   * Rätt svar är klart för idag. Fel svar kommer tillbaka en gång, RETRY_GAP kort
   * senare och (för regelbundna verb) i en annan person. Tar kön slut fylls den
   * på med dagens nya ord. Fast-track (easy) utlöser syskonuppskov och budgetåterbäring.
   */
  commit(now: Date = new Date()): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.counts[p.grade]++;
    // stavfel på SVENSKA (modersmålet) straffas inte — visas som stavfel i UI:t
    // men rättas som rätt; spanska stavfel är kunskap och förblir Hard
    const fsrsGrade: Grade =
      p.grade === "hard" && this.answerLang(p.card.dir) === "sv" ? "good" : p.grade;
    const updated = applyReview(p.card, fsrsGrade, now, { easy: p.easy });
    this.store.putCard(updated);
    this.store.logReview({
      ts: now.toISOString(),
      wordId: p.card.wordId,
      dir: p.card.dir,
      raw: p.raw,
      grade: fsrsGrade,
      step: p.step,
    });
    this.queue.shift();
    this.done++;
    const key = cardKey(p.card.wordId, p.card.dir);
    this.valdForm.delete(key);
    if (p.grade === "again" && !this.retried.has(key)) {
      this.retried.add(key);
      insertSpaced(this.queue, updated, RETRY_GAP);
    }
    if (p.easy && p.firstExposure) {
      this.deferSibling(p.card, now);
      this.maybeRefund(p.card, now);
    }
    // det förfallna är klart: dagens nya ord (och återbäringens extra) tar vid
    if (this.queue.length === 0) this.queue = spaceSiblings(this.store.startPortion(now));
    this.store.save();
  }

  /** Syskonuppskov: den orörda andra riktningen skjuts ~2 veckor fram. */
  private deferSibling(card: CardRec, now: Date): void {
    const otherDir: Dir = card.dir === "es2sv" ? "sv2es" : "es2sv";
    const sib = this.store.card(card.wordId, otherDir);
    if (!sib || sib.fsrs.reps > 0) return;
    const qi = this.queue.findIndex((c) => c.wordId === card.wordId && c.dir === otherDir);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.store.putCard({
      ...sib,
      fsrs: { ...sib.fsrs, due: new Date(now.getTime() + SIBLING_DEFER_MS).toISOString() },
    });
  }

  /**
   * Budgetåterbäring: ett ord som sitter vid första mötet kostar ingen
   * introduktionsplats — nästa enhet låses upp direkt (aldrig över
   * 3× nivåns dagsbudget).
   */
  private maybeRefund(card: CardRec, now: Date): void {
    const today = now.toDateString();
    if (new Date(card.introducedAt).toDateString() !== today) return;
    const cap = this.store.nivaConf().nya * REFUND_CAP_FACTOR;
    if (this.store.introducedToday(now) >= cap) return;
    this.store.introduceExtra(now); // hamnar i nästa pass — inte mitt i pågående kö
  }

  /** Ungefär så här många repetitioner har övningen lagt på kommande vecka. */
  forecastAdded(now: Date = new Date()): number {
    return Math.max(0, this.store.dueSoonCount(7, now) - this.dueSoonBaseline);
  }

  progress(): { done: number; total: number } {
    return { done: this.done, total: this.done + this.queue.length };
  }
}
