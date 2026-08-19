import type { Session, SupabaseClient } from "./supabase";
import type { Store } from "./store";
import type { AppData, CardRec, Dir, DirtyKind } from "./types";
import { cardKey } from "./types";
import { dayKey } from "./time";

/**
 * Molnsynk mot Supabase. Lokal data (localStorage) är alltid primär —
 * molnet är spegel + brygga mellan enheter. Merge sker per rad med
 * last-write-wins på updatedAt. Reviews är append-only och deduplas
 * med client_id, så omsynk är alltid ofarlig.
 */

interface CardRow {
  word_id: string; dir: Dir; fsrs: CardRec["fsrs"];
  fail_count: number; introduced_at: string; updated_at: string;
}
interface UserWordRow { word_id: string; syn: string[]; mnem: string; skip?: boolean; updated_at: string }
interface SettingsRow { new_per_day: number; updated_at: string }
interface SnapshotRow { day: string; kan: number; lar: number }

export interface CloudRows {
  cards: CardRow[];
  userWords: UserWordRow[];
  settings: SettingsRow | null;
  snapshots: SnapshotRow[];
  reviewTs: string[]; // tidsstämplar för kalender-merge (senaste ~120 dagarna)
}

/** true om a är strikt nyare än b (saknad tidsstämpel = äldst). */
export function newerThan(a?: string, b?: string): boolean {
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

/** Bästa gissning för uppdateringstid på poster skapade innan synken fanns. */
export function cardStamp(rec: CardRec): string {
  return rec.updatedAt ?? rec.fsrs.last_review ?? rec.introducedAt;
}

/** Muterar `data` med molnrader enligt last-write-wins. Returnerar antal adopterade rader. */
export function mergeCloudIntoLocal(data: AppData, cloud: CloudRows): number {
  let adopted = 0;
  for (const r of cloud.cards) {
    const key = cardKey(r.word_id, r.dir);
    const local = data.cards[key];
    if (!local || newerThan(r.updated_at, cardStamp(local))) {
      data.cards[key] = {
        wordId: r.word_id, dir: r.dir, fsrs: r.fsrs,
        failCount: r.fail_count, introducedAt: r.introduced_at, updatedAt: r.updated_at,
      };
      adopted++;
    }
  }
  for (const r of cloud.userWords) {
    const local = data.userWords[r.word_id];
    if (!local || newerThan(r.updated_at, local.updatedAt)) {
      data.userWords[r.word_id] = {
        syn: r.syn, mnem: r.mnem, updatedAt: r.updated_at,
        ...(r.skip ? { skip: true } : {}),
      };
      adopted++;
    }
  }
  if (cloud.settings && newerThan(cloud.settings.updated_at, data.settings.updatedAt)) {
    // new_per_day-kolumnen bär första övningens takt; newMore är lokal per enhet
    data.settings = {
      ...data.settings,
      newFirst: cloud.settings.new_per_day,
      updatedAt: cloud.settings.updated_at,
    };
    adopted++;
  }
  const today = dayKey();
  for (const r of cloud.snapshots) {
    if (r.day !== today && !data.snapshots[r.day]) {
      data.snapshots[r.day] = { kan: r.kan, lar: r.lar };
      adopted++;
    }
  }
  // kalendern: räkna molnets reviews per dag och ta max mot lokala räknare
  const cloudDays = new Map<string, number>();
  for (const ts of cloud.reviewTs) {
    const d = dayKey(new Date(ts));
    cloudDays.set(d, (cloudDays.get(d) ?? 0) + 1);
  }
  for (const [d, n] of cloudDays) {
    if ((data.days[d] ?? 0) < n) { data.days[d] = n; adopted++; }
  }
  return adopted;
}

/**
 * Rensar lokala regler som inte längre finns bland användarens egna molnrader.
 * Skyddar rader som väntar på push (dirty) och rader ändrade efter senaste synk
 * (offline-ändringar). Krävs för att serverstädning inte ska ångras av gamla
 * lokala kopior vid nästa pushEverything.
 */
export function reconcileUserWords(
  data: AppData,
  cloudWordIds: Set<string>,
  dirty: Set<string>,
  lastSyncAt: string,
): number {
  let dropped = 0;
  for (const wordId of Object.keys(data.userWords)) {
    if (cloudWordIds.has(wordId) || dirty.has(wordId)) continue;
    if (newerThan(data.userWords[wordId].updatedAt, lastSyncAt)) continue;
    delete data.userWords[wordId];
    dropped++;
  }
  return dropped;
}

interface SyncMeta { reviewsSynced: number; lastSyncAt?: string }
const META_KEY = "glosa.sync.v1";

export type SyncStatus = "off" | "syncing" | "idle" | "error";

export class CloudSync {
  session: Session | null = null;
  status: SyncStatus = "off";
  lastError = "";
  /** UI-hook: anropas när status ändras. */
  onStatus?: () => void;

  private dirtyCards = new Set<string>();
  private dirtyWords = new Set<string>();
  private dirtySnapshots = new Set<string>();
  private dirtySettings = false;
  private meta: SyncMeta = { reviewsSynced: 0 };
  private timer: number | null = null;
  private pushing = false;

  constructor(private store: Store, private sb: SupabaseClient) {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (raw) this.meta = { reviewsSynced: 0, ...JSON.parse(raw) };
    } catch { /* börja om från noll — dedupe skyddar */ }
  }

  private saveMeta(): void {
    try { localStorage.setItem(META_KEY, JSON.stringify(this.meta)); } catch { /* ignorera */ }
  }
  private setStatus(s: SyncStatus, err = ""): void {
    this.status = s;
    this.lastError = err;
    this.onStatus?.();
  }
  get lastSyncAt(): string | undefined {
    return this.meta.lastSyncAt;
  }

  markDirty(kind: DirtyKind, key?: string): void {
    if (!this.session) return;
    if (kind === "card" && key) this.dirtyCards.add(key);
    else if (kind === "userWord" && key) this.dirtyWords.add(key);
    else if (kind === "snapshot" && key) this.dirtySnapshots.add(key);
    else if (kind === "settings") this.dirtySettings = true;
    // reviews spåras via meta.reviewsSynced-räknaren
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.pushDirty(); }, 2500);
  }

  /** Skicka upp direkt (t.ex. när appen läggs i bakgrunden). */
  flush(): void {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    void this.pushDirty();
  }

  /** Vid inloggning: hämta molnet, mergea, skicka upp allt lokalt. Idempotent. */
  async initialSync(session: Session): Promise<void> {
    this.session = session;
    this.setStatus("syncing");
    try {
      const cloud = await this.pullAll();
      mergeCloudIntoLocal(this.store.data, cloud);
      // Har enheten synkat förut? Då ska regler som raderats i molnet inte
      // återuppstå ur gamla lokala kopior. Första synken hoppar över detta
      // så att offline-skapade regler bevaras och pushas.
      if (this.meta.lastSyncAt) {
        reconcileUserWords(
          this.store.data,
          new Set(cloud.userWords.map((r) => r.word_id)),
          this.dirtyWords,
          this.meta.lastSyncAt,
        );
      }
      this.store.save();
      await this.pushEverything();
      this.meta.lastSyncAt = new Date().toISOString();
      this.saveMeta();
      this.setStatus("idle");
    } catch (e) {
      this.setStatus("error", e instanceof Error ? e.message : String(e));
    }
  }

  signedOut(): void {
    this.session = null;
    this.setStatus("off");
  }

  // ---------- pull ----------
  private async pageAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      let q: any = this.sb.from(table).select(select).range(from, from + 999);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...(data as T[]));
      if ((data as T[]).length < 1000) break;
    }
    return out;
  }

  /**
   * Finns skip-kolumnen i molnet än? Migration 0004 kan släpa efter en deploy —
   * tills den körts synkas avstådda ord inte (lokalt funkar de ändå).
   */
  private skipKolumn: boolean | null = null;
  private async harSkipKolumn(): Promise<boolean> {
    if (this.skipKolumn === null) {
      const { error } = await this.sb.from("user_words").select("skip").limit(1);
      this.skipKolumn = !error;
    }
    return this.skipKolumn;
  }

  private async pullAll(): Promise<CloudRows> {
    // user_words är läsbar för alla inloggade (kompisregler) sedan 0002 —
    // egna pulls MÅSTE därför filtrera på user_id, annars adopteras andras
    // regler och sprids vidare vid nästa push. Övriga tabeller filtreras
    // likadant som skydd även om RLS redan begränsar dem.
    const uid = this.uid();
    const own = (q: any) => q.eq("user_id", uid);
    const since = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
    const uwSelect = (await this.harSkipKolumn())
      ? "word_id,syn,mnem,skip,updated_at" : "word_id,syn,mnem,updated_at";
    const [cards, userWords, snapshots, reviewRows] = await Promise.all([
      this.pageAll<CardRow>("cards", "word_id,dir,fsrs,fail_count,introduced_at,updated_at", own),
      this.pageAll<UserWordRow>("user_words", uwSelect, own),
      this.pageAll<SnapshotRow>("snapshots", "day,kan,lar", own),
      this.pageAll<{ ts: string }>("reviews", "ts", (q) => own(q).gte("ts", since)),
    ]);
    const { data: settings, error } = await this.sb
      .from("settings").select("new_per_day,updated_at").eq("user_id", uid).maybeSingle();
    if (error) throw new Error(`settings: ${error.message}`);
    return { cards, userWords, snapshots, settings, reviewTs: reviewRows.map((r) => r.ts) };
  }

  // ---------- push ----------
  private uid(): string {
    if (!this.session) throw new Error("inte inloggad");
    return this.session.user.id;
  }

  private cardRow(rec: CardRec) {
    return {
      user_id: this.uid(), word_id: rec.wordId, dir: rec.dir, fsrs: rec.fsrs,
      fail_count: rec.failCount, introduced_at: rec.introducedAt, updated_at: cardStamp(rec),
    };
  }

  /** user_words-rad — skip skickas bara när kolumnen finns (migration 0004). */
  private userWordRow(wordId: string, medSkip: boolean) {
    const uw = this.store.data.userWords[wordId];
    return {
      user_id: this.uid(), word_id: wordId, syn: uw.syn, mnem: uw.mnem,
      ...(medSkip ? { skip: !!uw.skip } : {}),
      updated_at: uw.updatedAt ?? new Date().toISOString(),
    };
  }

  private async upsertChunks(table: string, rows: unknown[], onConflict: string, ignoreDuplicates = false): Promise<void> {
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await this.sb.from(table)
        .upsert(rows.slice(i, i + 400) as never[], { onConflict, ignoreDuplicates });
      if (error) throw new Error(`${table}: ${error.message}`);
    }
  }

  private async pushReviews(): Promise<void> {
    const all = this.store.data.reviews;
    if (this.meta.reviewsSynced >= all.length) return;
    const rows = all.slice(this.meta.reviewsSynced).map((r) => ({
      user_id: this.uid(),
      client_id: `${r.ts}|${r.wordId}|${r.dir}`,
      ts: r.ts, word_id: r.wordId, dir: r.dir, raw: r.raw, grade: r.grade, step: r.step,
    }));
    await this.upsertChunks("reviews", rows, "user_id,client_id", true);
    this.meta.reviewsSynced = all.length;
    this.saveMeta();
  }

  private async pushSettings(): Promise<void> {
    const s = this.store.data.settings;
    const { error } = await this.sb.from("settings").upsert({
      user_id: this.uid(), new_per_day: s.newFirst,
      updated_at: s.updatedAt ?? new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw new Error(`settings: ${error.message}`);
  }

  private snapshotRows(days: string[]) {
    return days
      .filter((d) => this.store.data.snapshots[d])
      .map((d) => ({ user_id: this.uid(), day: d, ...this.store.data.snapshots[d] }));
  }

  private async pushEverything(): Promise<void> {
    const d = this.store.data;
    const medSkip = await this.harSkipKolumn();
    await this.upsertChunks("cards", Object.values(d.cards).map((c) => this.cardRow(c)), "user_id,word_id,dir");
    await this.upsertChunks("user_words",
      Object.keys(d.userWords).map((wordId) => this.userWordRow(wordId, medSkip)),
      "user_id,word_id");
    await this.pushSettings();
    await this.upsertChunks("snapshots", this.snapshotRows(Object.keys(d.snapshots)), "user_id,day");
    await this.pushReviews();
    this.dirtyCards.clear(); this.dirtyWords.clear(); this.dirtySnapshots.clear();
    this.dirtySettings = false;
  }

  async pushDirty(): Promise<void> {
    if (!this.session || this.pushing) return;
    this.pushing = true;
    this.setStatus("syncing");
    try {
      const d = this.store.data;
      if (this.dirtyCards.size) {
        const rows = [...this.dirtyCards].map((k) => d.cards[k]).filter(Boolean).map((c) => this.cardRow(c));
        await this.upsertChunks("cards", rows, "user_id,word_id,dir");
        this.dirtyCards.clear();
      }
      if (this.dirtyWords.size) {
        const medSkip = await this.harSkipKolumn();
        const rows = [...this.dirtyWords].filter((w) => d.userWords[w])
          .map((wordId) => this.userWordRow(wordId, medSkip));
        await this.upsertChunks("user_words", rows, "user_id,word_id");
        this.dirtyWords.clear();
      }
      if (this.dirtySettings) { await this.pushSettings(); this.dirtySettings = false; }
      if (this.dirtySnapshots.size) {
        await this.upsertChunks("snapshots", this.snapshotRows([...this.dirtySnapshots]), "user_id,day");
        this.dirtySnapshots.clear();
      }
      await this.pushReviews();
      this.meta.lastSyncAt = new Date().toISOString();
      this.saveMeta();
      this.setStatus("idle");
    } catch (e) {
      this.setStatus("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.pushing = false;
    }
  }
}
