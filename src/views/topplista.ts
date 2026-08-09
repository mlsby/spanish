import type { Social, StatsRow } from "../lib/social";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Board {
  emoji: string;
  name: string;
  what: string;
  value(userId: string): number;
}

export interface TopplistaDeps {
  social: Social;
  uid: string | null;
}

let editingName = false;

export async function renderTopplista(el: HTMLElement, deps: TopplistaDeps): Promise<void> {
  if (!deps.uid) {
    el.innerHTML = `<div class="tomt"><div class="stor">Topplistan</div>
      <p>Logga in (på Idag-fliken) så är du med — alla som kör Glosa tävlar automatiskt.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="tomt"><p>Hämtar topplistan …</p></div>`;
  const token = String(Date.now());
  el.dataset.render = token;

  const withTimeout = <T,>(p: Promise<T>, ms = 10000): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        window.setTimeout(() => rej(new Error("Nätverket svarar inte — försök igen om en stund.")), ms)
      ),
    ]);

  let names: Map<string, string>, stats: StatsRow[], adopts: Map<string, number>;
  try {
    [names, stats, adopts] = await withTimeout(Promise.all([
      deps.social.allProfiles(),
      deps.social.allStats(),
      deps.social.adoptionCounts(),
    ]));
  } catch (e) {
    if (el.dataset.render !== token) return;
    el.innerHTML = `<div class="tomt"><div class="stor">Hoppsan</div>
      <p>Kunde inte hämta topplistan. Har databassteget (migration 0002) körts?</p>
      <p class="omtext">${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
    return;
  }
  if (el.dataset.render !== token) return; // användaren hann byta flik och tillbaka

  const statBy = new Map(stats.map((s) => [s.user_id, s]));
  const everyone = [...new Set([...names.keys(), ...statBy.keys()])];
  const myName = names.get(deps.uid) ?? "";

  const boards: Board[] = [
    { emoji: "🔥", name: "Eld i baken", what: "dagar i rad", value: (u) => statBy.get(u)?.streak ?? 0 },
    { emoji: "📅", name: "Trotjänaren", what: "dagar totalt", value: (u) => statBy.get(u)?.total_days ?? 0 },
    { emoji: "🧠", name: "Ordmästaren", what: "kan det-ord", value: (u) => statBy.get(u)?.known_words ?? 0 },
    { emoji: "💡", name: "Regelfabriken", what: "snodda regler", value: (u) => adopts.get(u) ?? 0 },
  ];

  const boardHtml = (b: Board): string => {
    const rows = everyone
      .map((u) => ({ u, v: b.value(u) }))
      .sort((a, z) => z.v - a.v);
    const shown = rows.slice(0, 5);
    const meIdx = rows.findIndex((r) => r.u === deps.uid);
    if (meIdx >= 5) shown.push(rows[meIdx]);
    const rowHtml = shown.map((r) => {
      const rank = rows.indexOf(r) + 1;
      const isMe = r.u === deps.uid;
      const etta = rank === 1 && r.v > 0;
      return `<div class="lbr${etta ? " etta" : ""}${isMe ? " du" : ""}">
        <span class="rank">${rank}</span>
        <span class="who">${esc(names.get(r.u) ?? "okänd")}${isMe ? ' <span class="dutag">(du)</span>' : ""}</span>
        <span class="val">${r.v}</span></div>`;
    }).join("");
    return `<div class="lb">
      <div class="lbtitle"><span class="name">${b.emoji} ${esc(b.name)}</span><span class="what">${esc(b.what)}</span></div>
      ${rowHtml || `<p class="tpnote">Inga siffror än — kör ett pass!</p>`}</div>`;
  };

  const nameHtml = editingName
    ? `<div class="namerow"><form class="nameform" id="nameForm">
         <input id="nameInput" maxlength="24" value="${esc(myName)}" aria-label="Visningsnamn">
         <button class="btn" type="submit">Spara</button></form></div>`
    : `<div class="namerow"><span>Du visas som <b>${esc(myName || "…")}</b></span>
         <button type="button" class="linkbtn" id="nameEdit">ändra</button></div>`;

  el.innerHTML = `<div class="tp">
    <div class="apphead"><span class="brand">Topplistan</span>
      <span class="date">${everyone.length} ${everyone.length === 1 ? "spelare" : "spelare"}</span></div>
    ${nameHtml}
    ${boards.map(boardHtml).join("")}
    ${everyone.length <= 1
      ? `<p class="tpnote">Bara du här än så länge — dela applänken med gänget så dyker de upp här automatiskt.</p>`
      : ""}
    <p class="tpnote">Siffrorna uppdateras när var och en synkar. Snodda regler = någon tog din minnesregel via "sno"-knappen.</p>
  </div>`;

  el.querySelector<HTMLButtonElement>("#nameEdit")?.addEventListener("click", () => {
    editingName = true;
    void renderTopplista(el, deps);
  });
  el.querySelector<HTMLFormElement>("#nameForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = el.querySelector<HTMLInputElement>("#nameInput")!.value;
    try {
      await deps.social.setName(v);
      editingName = false;
      void renderTopplista(el, deps);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  });
}
