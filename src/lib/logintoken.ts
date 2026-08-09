/**
 * Inloggningsfältet accepterar två saker:
 *  - en engångskod (siffror) — kräver att mejlmallen innehåller {{ .Token }},
 *    vilket Supabase numera låser bakom egen SMTP/Pro
 *  - en inklistrad inloggningslänk ur mejlet — funkar med gratismallen och
 *    är enda vägen in i en installerad PWA på iOS (länkklick öppnar Safari,
 *    som har separat lagring)
 * Länken ser ut som https://<ref>.supabase.co/auth/v1/verify?token=<hash>&type=magiclink&…
 */
export type LoginInput =
  | { kind: "code"; code: string }
  | { kind: "link"; tokenHash: string; type: string };

export function parseLoginInput(raw: string): LoginInput | null {
  const v = raw.trim();
  if (!v) return null;
  const urlMatch = v.match(/https?:\/\/\S+/);
  if (urlMatch || v.includes("token=")) {
    try {
      const u = new URL(urlMatch ? urlMatch[0] : `https://x/?${v}`);
      const tokenHash = u.searchParams.get("token") ?? u.searchParams.get("token_hash");
      if (!tokenHash) return null;
      return { kind: "link", tokenHash, type: u.searchParams.get("type") ?? "magiclink" };
    } catch {
      return null;
    }
  }
  const code = v.replace(/[\s-]/g, "");
  if (/^\d{6,10}$/.test(code)) return { kind: "code", code };
  return null;
}
