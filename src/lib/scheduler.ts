import {
  fsrs, generatorParameters, createEmptyCard, Rating, State,
  type Card as FsrsCard, type Grade as FsrsGrade,
} from "ts-fsrs";
import type { CardRec, Dir, Grade, StoredFsrs } from "./types";

/** FSRS med default-parametrar och retention-mål 0,90 enligt kravspec §4. */
const scheduler = fsrs(generatorParameters({ request_retention: 0.9 }));

export const KNOWN_STABILITY_DAYS = 30;

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

/** Applicerar en repetition. Muterar inte — returnerar nytt CardRec. */
export function applyReview(rec: CardRec, grade: Grade, now: Date): CardRec {
  const { card } = scheduler.next(toLive(rec.fsrs), now, GRADE_TO_RATING[grade]);
  return {
    ...rec,
    fsrs: toStored(card),
    failCount: rec.failCount + (grade === "again" ? 1 : 0),
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
