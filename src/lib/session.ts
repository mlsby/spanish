import { gradeAnswer, normalize, type GradeResult } from "./grading";
import { insertSpaced, spaceSiblings } from "./queue";
import { applyReview, dueDate } from "./scheduler";
import type { Store } from "./store";
import { endOfToday } from "./time";
import type { CardRec, Dir, Grade, Step, VerbForm, Word } from "./types";

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

/** Kort som fastnar i korttidsinlärning visas igen inom samma pass om nästa due är nära. */
const RELEARN_WINDOW_MS = 15 * 60 * 1000;
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

  constructor(private store: Store, cards: CardRec[], opts?: { dueSoonBaseline?: number }) {
    // syskonkort (samma ord/moderverb) hålls isär så facit aldrig står kvar på skärmen
    this.queue = spaceSiblings(cards);
    // baslinjen tas helst FÖRE introduktionen — annars räknas dagens nya inte in
    this.dueSoonBaseline = opts?.dueSoonBaseline ?? this.store.dueSoonCount();
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
      if (c && dueDate(c).getTime() <= cutoff && !store.avstadd(wordId)) cards.push(c);
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
    const targets = this.store.targetsFor(card);
    const r: GradeResult = gradeAnswer(raw, targets, this.answerLang(card.dir));
    const firstExposure = card.fsrs.reps === 0;
    this.pending = {
      card, word, form: this.store.formFor(card), raw: raw.trim(),
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
    // formkort: synonymen hör till just den formen (kortets id), inte moderverbet —
    // annars läses den aldrig vid nästa rättning
    if (norm) this.store.addUserSyn(p.form ? p.card.wordId : p.word.id, norm);
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
   * Fel svar läggs tillbaka längre fram i kön; korttidsinlärda kort återkommer i slutet.
   * Fast-track (easy) utlöser syskonuppskov och budgetåterbäring.
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
    const nextDue = dueDate(updated).getTime() - now.getTime();
    if (p.grade === "again") {
      insertSpaced(this.queue, updated, 3);
    } else if (nextDue <= RELEARN_WINDOW_MS && this.queue.length > 0) {
      this.queue.push(updated);
    }
    if (p.easy && p.firstExposure) {
      this.deferSibling(p.card, now);
      this.maybeRefund(p.card, now);
    }
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
