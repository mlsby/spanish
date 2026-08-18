import type { SupabaseClient } from "./supabase";
import type { Store } from "./store";

/** En lektion ur kurskartan (public/data/kurs.json). */
export interface Lektion {
  n: number;
  fil: string;
  sek: number;
  om: string;
  ord: { es: string; en: string }[];
  fraser: { es: string; en: string }[];
  koncept: string[];
}

export interface TranskriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

interface OrdMapPost {
  ordId?: string;
  status?: string;
}

/** Synkat lyssningsläge: spelade lektioner + position, delat mellan enheter. */
export interface LyssnaLage {
  spelade: Set<number>;
  pos: Map<number, number>;
  aktuell: number;
}

const PEKARE = 0; // rad med lektion=0 bär numret på senast aktiva lektionen i pos

let kursCache: Lektion[] | null = null;
let ordPerLektion: Map<number, string[]> | null = null;

export async function laddaKurs(baseUrl: string): Promise<Lektion[]> {
  if (kursCache) return kursCache;
  const res = await fetch(`${baseUrl}data/kurs.json`);
  if (!res.ok) throw new Error(`kurs.json: HTTP ${res.status}`);
  kursCache = (await res.json()).lektioner as Lektion[];
  return kursCache;
}

/** Lektionsnummer -> ordbasens ordId:n (ur kurs-ord-map.json). */
export async function laddaOrdMap(baseUrl: string): Promise<Map<number, string[]>> {
  if (ordPerLektion) return ordPerLektion;
  const res = await fetch(`${baseUrl}data/kurs-ord-map.json`);
  if (!res.ok) throw new Error(`kurs-ord-map.json: HTTP ${res.status}`);
  const karta = (await res.json()).karta as Record<string, OrdMapPost>;
  const m = new Map<number, string[]>();
  for (const [nyckel, post] of Object.entries(karta)) {
    if (!post.ordId) continue;
    const n = Number(nyckel.split("|")[0]);
    if (!m.has(n)) m.set(n, []);
    const lista = m.get(n)!;
    if (!lista.includes(post.ordId)) lista.push(post.ordId);
  }
  ordPerLektion = m;
  return m;
}

export async function laddaTranskript(baseUrl: string, n: number): Promise<TranskriptSegment[]> {
  const res = await fetch(`${baseUrl}data/transkript/${String(n).padStart(3, "0")}.json`);
  if (!res.ok) throw new Error(`transkript ${n}: HTTP ${res.status}`);
  return (await res.json()).segments as TranskriptSegment[];
}

/** Hämta synkat läge från molnet (kräver inloggning). */
export async function hamtaLage(sb: SupabaseClient): Promise<LyssnaLage> {
  const { data, error } = await sb.from("lyssna").select("lektion,pos,spelad");
  if (error) throw new Error(error.message);
  const lage: LyssnaLage = { spelade: new Set(), pos: new Map(), aktuell: 0 };
  for (const r of data ?? []) {
    if (r.lektion === PEKARE) lage.aktuell = r.pos;
    else {
      if (r.spelad) lage.spelade.add(r.lektion);
      if (r.pos > 0) lage.pos.set(r.lektion, r.pos);
    }
  }
  return lage;
}

/** RLS kräver att user_id skickas med explicit — utan den nekas upserten tyst. */
async function uid(sb: SupabaseClient): Promise<string | null> {
  return (await sb.auth.getSession()).data.session?.user.id ?? null;
}

export async function sparaLektionslage(
  sb: SupabaseClient, lektion: number, pos: number, spelad: boolean
): Promise<void> {
  const user_id = await uid(sb);
  if (!user_id) return;
  const { error } = await sb.from("lyssna").upsert(
    { user_id, lektion, pos: Math.floor(pos), spelad, updated_at: new Date().toISOString() },
    { onConflict: "user_id,lektion" }
  );
  if (error) console.error("lyssna-synk:", error.message);
}

export async function sparaAktuell(sb: SupabaseClient, n: number): Promise<void> {
  const user_id = await uid(sb);
  if (!user_id) return;
  const { error } = await sb.from("lyssna").upsert(
    { user_id, lektion: PEKARE, pos: n, spelad: false, updated_at: new Date().toISOString() },
    { onConflict: "user_id,lektion" }
  );
  if (error) console.error("lyssna-synk:", error.message);
}

/**
 * FSRS-kopplingen: spelade lektioners ord blir toppkandidater i
 * introduktionskön. Lektionsordning (kursen bygger progressivt), ordens
 * ordning inom lektionen bevaras. Anropas vid boot/inlogg och när en
 * lektion markeras spelad.
 */
export async function uppdateraBoost(store: Store, sb: SupabaseClient, baseUrl: string): Promise<void> {
  try {
    const [karta, lage] = await Promise.all([laddaOrdMap(baseUrl), hamtaLage(sb)]);
    const ids: string[] = [];
    for (const n of [...lage.spelade].sort((a, b) => a - b)) {
      for (const id of karta.get(n) ?? []) if (!ids.includes(id)) ids.push(id);
    }
    store.setLyssnaPrio(ids);
  } catch {
    // boosten är grädde — utan nät/inlogg fortsätter kön i vanlig frekvensordning
  }
}
