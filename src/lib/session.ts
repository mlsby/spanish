import { gradeAnswer, normalize, type GradeResult } from "./grading";
import { insertSpaced, spaceSiblings } from "./queue";
import { applyReview, dueDate } from "./scheduler";
import type { Store } from "./store";
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

/** Kort som fastnar i korttidsinlärning visas igen inom samma pass om nästa due är nära. */
const RELEARN_WINDOW_MS = 15 * 60 * 1000;
/** Syskonuppskov: klaras första riktningen exakt väntar andra riktningen ~2 veckor. */
const SIBLING_DEFER_MS = 14 * 24 * 3600 * 1000;
/** Budgetåterbäringens tak: max 3× dagstakten i totala introduktioner per dag. */
const REFUND_CAP_FACTOR = 3;
/** Turbo: fyll på kön när den krymper under så här många kort. */
const TURBO_LOW_WATER = 4;

export interface SessionOpts {
  /** "Plocka fler"-läget: bara nya enheter, fylls på tills basen tar slut. */
  turbo?: boolean;
}

export class Session {
  queue: CardRec[] = [];
  done = 0;
  counts: SessionCounts = { good: 0, hard: 0, again: 0 };
  pending: Pending | null = null;
  readonly turbo: boolean;
  /** turbo: antal plockade enheter */
  turboPicked = 0;
  /** turbo: utfall (exakt rätt?) för de senaste första-mötena — driver mjuka bromsen */
  private turboOutcomes: boolean[] = [];
  /** kort med due inom 7 dagar vid sessionsstart — för prognosraden */
  private dueSoonBaseline = 0;

  constructor(private store: Store, cards: CardRec[], opts?: SessionOpts) {
    this.turbo = opts?.turbo ?? false;
    // syskonkort (samma ord/moderverb) hålls isär så facit aldrig står kvar på skärmen
    this.queue = spaceSiblings(cards);
    if (this.turbo) {
      this.dueSoonBaseline = this.dueSoonCount();
      this.refillTurbo();
    }
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
   * Bekräfta utfallet: FSRS uppdateras, reviewloggen skrivs, kortet lämnar kön.
   * Fel svar läggs tillbaka längre fram i kön; korttidsinlärda kort återkommer i slutet.
   * Fast-track (easy) utlöser syskonuppskov och budgetåterbäring.
   */
  commit(now: Date = new Date()): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.counts[p.grade]++;
    const updated = applyReview(p.card, p.grade, now, { easy: p.easy });
    this.store.putCard(updated);
    this.store.logReview({
      ts: now.toISOString(),
      wordId: p.card.wordId,
      dir: p.card.dir,
      raw: p.raw,
      grade: p.grade,
      step: p.step,
    });
    this.queue.shift();
    this.done++;
    if (this.turbo && p.firstExposure && p.card.dir === "es2sv") {
      this.turboOutcomes.push(p.easy);
      if (this.turboOutcomes.length > 20) this.turboOutcomes.shift();
    }
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
    if (this.turbo) this.refillTurbo(now);
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
   * introduktionsplats — nästa enhet låses upp direkt (dock inte i turbo,
   * som ändå fyller på, och aldrig över 3× dagstakten).
   */
  private maybeRefund(card: CardRec, now: Date): void {
    if (this.turbo) return;
    const today = now.toDateString();
    if (new Date(card.introducedAt).toDateString() !== today) return;
    const cap = this.store.data.settings.newPerDay * REFUND_CAP_FACTOR;
    if (this.store.introducedToday(now) >= cap) return;
    this.store.introduceExtra(now); // hamnar i nästa pass — inte mitt i pågående kö
  }

  /** Turbo: håll kön påfylld med nya enheter tills ordbasen tar slut. */
  private refillTurbo(now: Date = new Date()): void {
    while (this.queue.length < TURBO_LOW_WATER) {
      const fresh = this.store.introduceUnits(2, now);
      if (!fresh.length) break;
      this.turboPicked += fresh.length / 2;
      // es→sv-korten först, sv→es efter — ger naturligt syskonavstånd
      for (const c of fresh.filter((c) => c.dir === "es2sv")) this.queue.push(c);
      for (const c of fresh.filter((c) => c.dir === "sv2es")) this.queue.push(c);
    }
  }

  /** Turbo: föreslå paus när exakt-träffen sjunkit — då gissar man mer än man kan. */
  get turboBrake(): boolean {
    if (!this.turbo || this.turboOutcomes.length < 10) return false;
    const hits = this.turboOutcomes.filter(Boolean).length;
    return hits / this.turboOutcomes.length < 0.6;
  }

  private dueSoonCount(now: Date = new Date()): number {
    const cutoff = now.getTime() + 7 * 24 * 3600 * 1000;
    let n = 0;
    for (const key in this.store.data.cards) {
      if (dueDate(this.store.data.cards[key]).getTime() <= cutoff) n++;
    }
    return n;
  }

  /** Turbo: ungefär så här många repetitioner har sessionen lagt på kommande vecka. */
  forecastAdded(now: Date = new Date()): number {
    return Math.max(0, this.dueSoonCount(now) - this.dueSoonBaseline);
  }

  progress(): { done: number; total: number } {
    return { done: this.done, total: this.done + this.queue.length };
  }
}
