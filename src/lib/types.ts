import type { Card as FsrsCard } from "ts-fsrs";

export type Dir = "es2sv" | "sv2es";

export interface Word {
  id: string;
  rank: number;
  es: string;
  pos: string;
  sv: string;
  syn: string[];
  art?: string;
  src?: string;
  /** parentes-ledtråd som särskiljer svenska dubbletter ("vara (egenskap)") */
  hint?: string;
  /** alternativa spanska svar som också godkänns (äkta synonymer: empezar/comenzar) */
  alt?: string[];
}

export interface UserWord {
  syn: string[]; // användarens egna synonymtillägg (inkl. "jag hade rätt"-overrides)
  mnem: string;  // minnesregeln — alltid användarens egen text
  updatedAt?: string; // för last-write-wins vid molnsynk
}

/** Serialiserat FSRS-kort: datum som ISO-strängar. */
export type StoredFsrs = Omit<FsrsCard, "due" | "last_review"> & {
  due: string;
  last_review?: string;
};

export interface CardRec {
  wordId: string;
  dir: Dir;
  fsrs: StoredFsrs;
  failCount: number; // antal felsvar totalt — driver tvåfelsregeln
  introducedAt: string;
  updatedAt?: string; // för last-write-wins vid molnsynk
}

export type Grade = "again" | "hard" | "good";
export type Step = "exact" | "syn" | "fuzzy" | "override" | "none";

export interface ReviewRec {
  ts: string;
  wordId: string;
  dir: Dir;
  raw: string;
  grade: Grade;
  step: Step;
}

export interface Settings {
  newPerDay: number;
  updatedAt?: string; // för last-write-wins vid molnsynk
}

/** Vad som ändrats lokalt — driver vilka rader synken behöver skicka upp. */
export type DirtyKind = "card" | "userWord" | "settings" | "snapshot" | "review";

export interface AppData {
  version: 1;
  settings: Settings;
  userWords: Record<string, UserWord>;
  cards: Record<string, CardRec>; // nyckel: `${wordId}:${dir}`
  reviews: ReviewRec[];
  introduced: Record<string, number>; // dagKey -> antal nya ord introducerade
  days: Record<string, number>;       // dagKey -> antal besvarade kort (kalendern)
  snapshots: Record<string, { kan: number; lar: number }>; // dagKey -> statusläge (grafen)
}

export const cardKey = (wordId: string, dir: Dir) => `${wordId}:${dir}`;

export const POS_LABEL: Record<string, string> = {
  n: "substantiv", v: "verb", adj: "adjektiv", adv: "adverb",
  pron: "pronomen", prep: "preposition", conj: "konjunktion",
  interj: "interjektion", num: "räkneord", determiner: "pronomen",
  phrase: "uttryck",
};
