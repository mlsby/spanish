import type { SupabaseClient } from "./supabase";

/**
 * Det sociala lagret: alla i appen är med. Profiler (visningsnamn),
 * topplistestatistik (skrivs av ägaren själv — ärlighet på kompisnivå),
 * delade minnesregler och sno-poäng. Kräver migration 0002.
 */

export interface StatsRow {
  user_id: string;
  streak: number;
  total_days: number;
  score: number; // resapoängen: kan det + på väg
}

export interface FriendRule {
  ownerId: string;
  name: string;
  mnem: string;
}

export class Social {
  private nameCache: Map<string, string> | null = null;
  private nameCacheAt = 0;
  private marksCache: Map<string, string[]> | null = null;
  private marksCacheAt = 0;

  constructor(private sb: SupabaseClient, private uid: () => string | null) {}

  /** Skapa profil med mejl-prefixet som namn om ingen finns — noll friktion, går att ändra. */
  async ensureProfile(email: string | null | undefined): Promise<void> {
    const uid = this.uid();
    if (!uid) return;
    const { data, error } = await this.sb
      .from("profiles").select("display_name").eq("user_id", uid).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      const fallback = (email ?? "").split("@")[0].slice(0, 24) || "spelare";
      const { error: e2 } = await this.sb
        .from("profiles").upsert({ user_id: uid, display_name: fallback }, { onConflict: "user_id" });
      if (e2) throw new Error(e2.message);
      this.nameCache = null;
    }
  }

  async setName(name: string): Promise<void> {
    const uid = this.uid();
    const trimmed = name.trim().slice(0, 24);
    if (!uid || !trimmed) return;
    const { error } = await this.sb
      .from("profiles")
      .upsert({ user_id: uid, display_name: trimmed, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    this.nameCache = null;
  }

  async allProfiles(): Promise<Map<string, string>> {
    if (this.nameCache && Date.now() - this.nameCacheAt < 60_000) return this.nameCache;
    const { data, error } = await this.sb.from("profiles").select("user_id,display_name");
    if (error) throw new Error(error.message);
    this.nameCache = new Map((data ?? []).map((r) => [r.user_id as string, r.display_name as string]));
    this.nameCacheAt = Date.now();
    return this.nameCache;
  }

  async allStats(): Promise<StatsRow[]> {
    const { data, error } = await this.sb
      .from("public_stats").select("user_id,streak,total_days,score");
    if (error) throw new Error(error.message);
    return (data ?? []) as StatsRow[];
  }

  /** Sno-poäng per regelägare. */
  async adoptionCounts(): Promise<Map<string, number>> {
    const { data, error } = await this.sb.from("rule_adoptions").select("owner_id");
    if (error) throw new Error(error.message);
    const counts = new Map<string, number>();
    for (const r of data ?? []) {
      const k = r.owner_id as string;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }

  async pushStats(s: { streak: number; totalDays: number; score: number }): Promise<void> {
    const uid = this.uid();
    if (!uid) return;
    await this.sb.from("public_stats").upsert({
      user_id: uid, streak: s.streak, total_days: s.totalDays,
      score: s.score, updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  }

  /**
   * Alla ord där någon kompis skrivit en minnesregel: ord-id → namn.
   * En klumpfråga för ordlistans 💡-chippar (cache ~5 min). Tom map
   * utloggad eller vid fel — listan ska aldrig störas av det sociala.
   */
  async ruleMarks(): Promise<Map<string, string[]>> {
    const uid = this.uid();
    if (!uid) return new Map();
    if (this.marksCache && Date.now() - this.marksCacheAt < 300_000) return this.marksCache;
    try {
      const { data, error } = await this.sb
        .from("user_words").select("word_id,user_id")
        .neq("mnem", "").neq("user_id", uid);
      if (error) return new Map();
      const names = await this.allProfiles();
      const map = new Map<string, string[]>();
      for (const r of data ?? []) {
        const name = names.get(r.user_id as string) ?? "okänd";
        const list = map.get(r.word_id as string) ?? [];
        if (!list.includes(name)) list.push(name);
        map.set(r.word_id as string, list);
      }
      for (const list of map.values()) list.sort();
      this.marksCache = map;
      this.marksCacheAt = Date.now();
      return map;
    } catch {
      return new Map();
    }
  }

  /** Kompisarnas minnesregler för ett ord (kräver inloggning + migration 0002). */
  async friendRules(wordId: string): Promise<FriendRule[]> {
    const uid = this.uid();
    if (!uid) return [];
    try {
      const { data, error } = await this.sb
        .from("user_words").select("user_id,mnem")
        .eq("word_id", wordId).neq("mnem", "").neq("user_id", uid);
      if (error || !data?.length) return [];
      const names = await this.allProfiles();
      return data.map((r) => ({
        ownerId: r.user_id as string,
        name: names.get(r.user_id as string) ?? "okänd",
        mnem: r.mnem as string,
      }));
    } catch {
      return []; // socialt lager saknas/otillgängligt — passet ska aldrig störas av det
    }
  }

  /** 1 sno-poäng per (snoare, ord, ägare) — dubbletter ignoreras tyst. */
  async recordAdoption(ownerId: string, wordId: string): Promise<void> {
    const uid = this.uid();
    if (!uid || uid === ownerId) return;
    try {
      await this.sb.from("rule_adoptions").upsert(
        { user_id: uid, owner_id: ownerId, word_id: wordId },
        { onConflict: "user_id,word_id,owner_id", ignoreDuplicates: true }
      );
    } catch {
      /* poängen är grädde — aldrig blockera flödet */
    }
  }
}
