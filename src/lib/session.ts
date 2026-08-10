import { gradeAnswer, normalize, type GradeResult } from "./grading";
import { insertSpaced, spaceSiblings } from "./queue";
import { applyReview, dueDate } from "./scheduler";
import type { Store } from "./store";
import type { CardRec, Dir, Grade, Step, Word } from "./types";

export interface Pending {
  card: CardRec;
  word: Word;
  raw: string;
  grade: Grade;
  step: Step;
  matched?: string;
  /** blir detta fel nr 2+ på kortet? → minnesregel obligatorisk */
  forcedMnem: boolean;
}

export interface SessionCounts { good: number; hard: number; again: number }

/** Kort som fastnar i korttidsinlärning visas igen inom samma pass om nästa due är nära. */
const RELEARN_WINDOW_MS = 15 * 60 * 1000;

export class Session {
  queue: CardRec[] = [];
  done = 0;
  counts: SessionCounts = { good: 0, hard: 0, again: 0 };
  pending: Pending | null = null;

  constructor(private store: Store, cards: CardRec[]) {
    // syskonkort (samma ord, olika riktning) hålls isär så facit aldrig står kvar på skärmen
    this.queue = spaceSiblings(cards);
  }

  get current(): CardRec | null {
    return this.queue[0] ?? null;
  }

  get finished(): boolean {
    return this.queue.length === 0;
  }

  word(card: CardRec): Word {
    const w = this.store.byId.get(card.wordId);
    if (!w) throw new Error(`okänt ord: ${card.wordId}`);
    return w;
  }

  answerLang(dir: Dir): "sv" | "es" {
    return dir === "es2sv" ? "sv" : "es";
  }

  /** Rätta svaret (steg 1–2). Ingenting sparas förrän commit(). */
  answer(raw: string): Pending {
    const card = this.current;
    if (!card) throw new Error("inget aktuellt kort");
    const word = this.word(card);
    const targets = this.store.targets(word, card.dir);
    const r: GradeResult = gradeAnswer(raw, targets, this.answerLang(card.dir));
    this.pending = {
      card, word, raw: raw.trim(),
      grade: r.grade, step: r.step, matched: r.matched,
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
    if (norm) this.store.addUserSyn(p.word.id, norm);
    this.pending = { ...p, grade: "hard", step: "override", forcedMnem: false };
    return this.pending;
  }

  /**
   * Bekräfta utfallet: FSRS uppdateras, reviewloggen skrivs, kortet lämnar kön.
   * Fel svar läggs tillbaka längre fram i kön; korttidsinlärda kort återkommer i slutet.
   */
  commit(now: Date = new Date()): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.counts[p.grade]++;
    const updated = applyReview(p.card, p.grade, now);
    this.store.putCard(updated);
    this.store.logReview({
      ts: now.toISOString(),
      wordId: p.word.id,
      dir: p.card.dir,
      raw: p.raw,
      grade: p.grade,
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
    this.store.save();
  }

  progress(): { done: number; total: number } {
    return { done: this.done, total: this.done + this.queue.length };
  }
}
