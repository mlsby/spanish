// Glosa · promptmotor — generisk och medvetet dum: appen äger hela prompten
// och all validering, funktionen äger bara API-nyckeln. Ny prompt, nya regler,
// nya features = bara app-deploy. Den här behöver bara omdeployas om modellen
// eller kostnadstaken ska ändras.
//
// POST-body:
// {
//   system?: string,                     // systemprompt (valfri)
//   user:    string,                     // användarmeddelandet
//   schema?: object,                     // JSON-schema → strukturerat svar
//   effort?: "low" | "medium" | "high"   // default medium
// }
// Svar 200: { text: string }             — modellens råa textsvar
// Svar 4xx/5xx: { fel: "..." }
//
// Kräver inloggad användare (JWT). Modell och max_tokens är låsta här —
// det är kostnadsspärren som motiverar att funktionen alls finns.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const MODELL = "claude-sonnet-5";
const MAX_TOKENS = 6000;
const EFFORT = new Set(["low", "medium", "high"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { fel: "bara POST" });

  // kräver inloggad användare — anon-nyckeln räcker inte
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(401, { fel: "logga in först" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { fel: "ogiltig JSON" });
  }

  const system = String(body.system ?? "").slice(0, 10_000);
  const userMsg = String(body.user ?? "").slice(0, 30_000);
  if (!userMsg.trim()) return json(400, { fel: "user-prompt krävs" });

  const outputConfig: Record<string, unknown> = {
    effort: EFFORT.has(String(body.effort)) ? String(body.effort) : "medium",
  };
  if (body.schema && typeof body.schema === "object") {
    if (JSON.stringify(body.schema).length > 10_000) return json(400, { fel: "schemat är för stort" });
    outputConfig.format = { type: "json_schema", schema: body.schema };
  }

  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
  let res;
  try {
    res = await anthropic.messages.create({
      model: MODELL,
      max_tokens: MAX_TOKENS,
      ...(system.trim() ? { system } : {}),
      output_config: outputConfig,
      messages: [{ role: "user", content: userMsg }],
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 429 || status === 529) return json(503, { fel: "modellen är upptagen — prova strax igen" });
    console.error("anthropic:", e);
    return json(502, { fel: "textmotorn svarade inte" });
  }
  if (res.stop_reason === "refusal") return json(502, { fel: "textmotorn avböjde" });
  const textBlock = res.content.find((c) => c.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return json(502, { fel: `inget textsvar (stop_reason: ${res.stop_reason})` });
  }
  return json(200, { text: textBlock.text });
});
