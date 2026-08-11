import {
  fsrs, generatorParameters, createEmptyCard, Rating, State,
  type Card as FsrsCard, type Grade as FsrsGrade,
} from "ts-fsrs";
import type { CardRec, Dir, Grade, StoredFsrs } from "./types";

/** FSRS med default-parametrar och retention-mål 0,90 enligt kravspec §4. */
const scheduler = fsrs(generatorParameters({ request_retention: 0.9 }));

// Anki-mature-konventionen: tredje lyckade repetitionen (~25 d stabilitet)
// ska räcka — se docs/research-troskel.md
export const KNOWN_STABILITY_DAYS = 21;

function toStored(c: FsrsCard): StoredFsrs {
  return {
    ...c,
    due: c.due.toISOString(),
    last_review: c.last_review ? c.last_review.toISOString() : undefined,
  };
}

function toLive(s: StoredFsrs): FsrsCard {
  return {
    ...s,
    due: new Date(s.due),
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  } as FsrsCard;
}

export function newCardRec(wordId: string, dir: Dir, now: Date): CardRec {
  return {
    wordId,
    dir,
    fsrs: toStored(createEmptyCard(now)),
    failCount: 0,
    introducedAt: now.toISOString(),
  };
}

const GRADE_TO_RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
};

/**
 * Applicerar en repetition. Muterar inte — returnerar nytt CardRec.
 * `easy: true` uppgraderar ett good-betyg till FSRS Easy (fast-track för
 * förkunskaper: hoppar över korttidsstegen, rakt till dagar/veckor).
 */
export function applyReview(rec: CardRec, grade: Grade, now: Date, opts?: { easy?: boolean }): CardRec {
  const rating = opts?.easy && grade === "good" ? Rating.Easy : GRADE_TO_RATING[grade];
  const { card } = scheduler.next(toLive(rec.fsrs), now, rating);
  return {
    ...rec,
    fsrs: toStored(card),
    failCount: rec.failCount + (grade === "again" ? 1 : 0),
  };
}

/**
 * Manuellt satt nivå (nivåstegen i ordlistan): kortet får Review-status med
 * vald stabilitet och kollas ärligt när det förfaller — failar man då tar
 * vanlig inlärning över. Saknas kortet skapas det (räknas som dagens intro).
 */
export function levelCardRec(
  base: CardRec | undefined, wordId: string, dir: Dir, days: number, now: Date
): CardRec {
  const b = base ?? newCardRec(wordId, dir, now);
  return {
    ...b,
    fsrs: {
      ...b.fsrs,
      state: State.Review,
      reps: Math.max(b.fsrs.reps, 1),
      stability: days,
      difficulty: b.fsrs.difficulty || 5,
      elapsed_days: 0,
      scheduled_days: days,
      due: new Date(now.getTime() + days * 86400e3).toISOString(),
      last_review: now.toISOString(),
    },
  };
}

export function dueDate(rec: CardRec): Date {
  return new Date(rec.fsrs.due);
}

export function isKnown(rec: CardRec): boolean {
  return rec.fsrs.stability >= KNOWN_STABILITY_DAYS;
}

export function isNew(rec: CardRec): boolean {
  return rec.fsrs.state === State.New;
}

export function stabilityDays(rec: CardRec): number {
  return Math.round(rec.fsrs.stability);
}
