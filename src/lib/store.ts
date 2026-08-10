import type { AppData, CardRec, Dir, DirtyKind, ReviewRec, UserWord, Word } from "./types";
import { cardKey } from "./types";
import { dueDate, isKnown, newCardRec } from "./scheduler";
import { emptyData, LocalStorageAdapter, type StorageAdapter } from "./storage";
import { dayKey, endOfToday } from "./time";

export interface WordStatus {
  word: Word;
  cards: CardRec[];
  status: "ny" | "lar" | "kan";
  minStability: number;
}

export class Store {
  words: Word[] = [];
  byId = new Map<string, Word>();
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

  /** Introducerar dagens nya ord (upp till dagstakten), i frekvensordning. Idempotent per dag. */
  introduceToday(now: Date = new Date()): CardRec[] {
    const already = this.introducedToday(now);
    const room = Math.max(0, this.data.settings.newPerDay - already);
    return this.introduceWords(room, now);
  }

  /**
   * Bonusord: plockar n extra ord utanför dagstaktens rumskoll. Eftersom
   * introducedToday() bara räknar dagens kalenderdag påverkas inte
   * morgondagens kvot — bonus är gratis imorgon. (Plockas bonus innan dagens
   * vanliga ord är slut räknas de dock in i dagens tak.)
   */
  introduceBonus(n: number, now: Date = new Date()): CardRec[] {
    return this.introduceWords(n, now);
  }

  private introduceWords(count: number, now: Date): CardRec[] {
    if (count <= 0) return [];
    // es→sv-korten först, sv→es-korten efter — så förhörs inte samma ord rygg i rygg
    const picked: string[] = [];
    for (const w of this.words) {
      if (picked.length >= count) break;
      if (!this.card(w.id, "es2sv")) picked.push(w.id);
    }
    const fresh: CardRec[] = [];
    for (const id of picked) {
      const a = newCardRec(id, "es2sv", now);
      this.putCard(a);
      fresh.push(a);
    }
    for (const id of picked) {
      const b = newCardRec(id, "sv2es", new Date(now.getTime() + 1));
      this.putCard(b);
      fresh.push(b);
    }
    this.save();
    return fresh;
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
    if (cards.length === 0) return { word, cards, status: "ny", minStability: 0 };
    const minStability = Math.min(...cards.map((c) => c.fsrs.stability));
    const status = cards.length === 2 && cards.every(isKnown) ? "kan" : "lar";
    return { word, cards, status, minStability };
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
    const newAvailable = Math.min(newLeftToday, ny);
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
