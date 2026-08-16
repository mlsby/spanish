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

/** Verbböjning (fas 1: presens). Kort-id:t blir `${parent}#pres.${person}`. */
export interface VerbForm {
  id: string;      // "poder|v#pres.1s"
  parent: string;  // moderverbets ord-id ("poder|v")
  es: string;      // "puedo"
  person: "1s" | "2s" | "3s" | "1p" | "3p";
  svPres: string;  // svensk presens ("kan") — prompten blir "jag kan"
  r: number;       // formens egen korpusrank (es_50k)
  slot: number;    // lemma-position där formen hör hemma i intro-kön
  /** extra godkända svar sv→es (krockande former utan hint + moderverbets alt-former) */
  accept?: string[];
}

export const PERSON_SV: Record<VerbForm["person"], string> = {
  "1s": "jag", "2s": "du", "3s": "han/hon", "1p": "vi", "3p": "de",
};

/** Pronomen som godkänns i svaret — facit visar PERSON_SV, men alla dessa räknas rätt. */
export const PERSON_SV_SVAR: Record<VerbForm["person"], string[]> = {
  "1s": ["jag"], "2s": ["du"], "3s": ["han", "hon", "den", "det"],
  "1p": ["vi"], "3p": ["de", "dom"],
};

/** Nyckeln som håller isär "syskon" i passkön — formkort delar moderverbets nyckel. */
export const parentKey = (wordId: string): string => wordId.split("#")[0];

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

/** Ordets nivå i ordlistan — beräknad ur FSRS, men flyttbar för hand (nivåstegen). */
export type Level = "ny" | "ovar" | "pagang" | "kan";

export const LEVEL_SV: Record<Level, string> = {
  ny: "Ny", ovar: "Övar", pagang: "På gång", kan: "Kan det",
};

export interface ReviewRec {
  ts: string;
  wordId: string;
  dir: Dir;
  raw: string;
  grade: Grade;
  step: Step;
}

/** Ambitionsnivån styr portionsstorlek och dagsbudget för nya ord. */
export type Niva = "lugn" | "lagom" | "ambitios";

export interface Settings {
  /** ambitionsnivå: portionens kort + nya ord per dag (lokal, synkas inte) */
  niva: Niva;
  /** pensionerad — låg till grund för gamla övningsmodellen (synkas som new_per_day) */
  newFirst: number;
  /** pensionerad — nya ord per "Öva mer" i gamla modellen */
  newMore: number;
  /** facit vid rätt: gå vidare automatiskt? (lokal, synkas inte) */
  autoNext: boolean;
  /** hur länge facit visas vid rätt, ms (lokal, synkas inte) */
  autoMs: number;
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
