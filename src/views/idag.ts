import { LAS_UNLOCK, lasNiva } from "../lib/lastext";
import { loadPass } from "../lib/passpaus";
import { dagarKvar, MIN_DAGAR, nyaIdag, prognosOrd, taktPerDag } from "../lib/prognos";
import { resaFor, TITLAR } from "../lib/resa";
import { NIVAER, type Store } from "../lib/store";
import { exportBlob, parseImport, LocalStorageAdapter } from "../lib/storage";
import { activityStats } from "../lib/streak";
import { addDays, dayKey, fmtDate, weekdayMon } from "../lib/time";
import type { SyncStatus } from "../lib/sync";
import type { Niva } from "../lib/types";

export interface IdagCallbacks {
  startPass(): void;
  /** läsförståelse — låses upp vid Turista (100 poäng) */
  startLas(): void;
}

export interface CloudUi {
  email: string | null; // inloggad adress, eller null
  status: SyncStatus;
  lastSyncAt?: string;
  lastError: string;
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  signOut(): Promise<void>;
}

// modul-state så det överlever omrenderingar
let pendingEmail = "";
let authError = "";
let settingsOpen = false;

/** Tvinga fram kontopanelen — synkfel måste kunna visas även från dashboarden. */
export function oppnaKonto(): void {
  settingsOpen = true;
}
let resaOpen = false; // nivåtrappan utfälld? (minns tills appen laddas om)
let valdTyp: "glosor" | "las" | null = null; // typväljaren; null = följ förvalet

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const IC_GEAR =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>';

function heatClass(n: number): string {
  if (n <= 0) return "";
  if (n < 10) return "h1";
  if (n < 25) return "h2";
  if (n < 50) return "h3";
  return "h4";
}

/** Kalender-heatmap: 15 veckor bakåt, mån–sön, färgad efter antal besvarade kort. */
function heatmapHtml(days: Record<string, number>): string {
  const today = new Date();
  const monday = addDays(today, -weekdayMon(today)); // denna veckas måndag
  const weeks: string[] = [];
  let practiced30 = 0;
  for (let i = 1; i <= 30; i++) {
    if ((days[dayKey(addDays(today, -(i - 1)))] ?? 0) > 0) practiced30++;
  }
  for (let w = 14; w >= 0; w--) {
    const cells: string[] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, -w * 7 + d);
      const key = dayKey(date);
      const n = days[key] ?? 0;
      const isToday = key === dayKey(today);
      const future = date.getTime() > today.getTime() && !isToday;
      cells.push(
        `<div class="d ${heatClass(n)}${isToday ? " nu" : ""}${future ? " framtid" : ""}"` +
          ` title="${key}: ${n} kort"></div>`
      );
    }
    weeks.push(`<div class="vecka">${cells.join("")}</div>`);
  }
  return `
    <div class="heat">${weeks.join("")}</div>
    <div class="heatcap">
      <span>övat ${practiced30} av senaste 30 dagarna</span>
      <span class="heatleg">färre
        <i style="background:var(--heat0)"></i><i style="background:var(--heat1)"></i>
        <i style="background:var(--heat2)"></i><i style="background:var(--heat3)"></i>
        <i style="background:var(--heat4)"></i> fler</span>
    </div>`;
}

/** Resan-panelen: två speglade sektioner i ett objekt — Nu (läget idag med
 *  kan/på väg-splitten) och Resan till Mexiko (prognosen med grafen).
 *  Statraderna delar kolumnform: ord · tid · nivå. Tryck fäller ut trappan. */
function resanPanelHtml(store: Store): string {
  const s = store.stats();
  const now = new Date();
  const r = resaFor(s.score);
  const takt = taktPerDag(Object.values(store.data.cards), now);
  const prognos = takt ? prognosOrd(s.score, takt, now, store.words.length + store.forms.length) : null;
  const rp = prognos === null ? null : resaFor(prognos);

  // --- Nu: statrad, meter mot nästa tröskel, ev. trappan ---
  const scale = r.next ? r.next.min : Math.max(s.score, TITLAR[TITLAR.length - 1].min);
  const kanPct = Math.min(100, (s.kan / scale) * 100);
  const larPct = Math.min(100 - kanPct, (s.lar / scale) * 100);
  const trappa = resaOpen
    ? `<div class="trappa">${TITLAR.map((t, i) => {
        const cls = i < r.nr - 1 ? "klar" : i === r.nr - 1 ? "nu" : "last";
        const krav = cls === "nu" ? (r.next ? `${s.score}/${r.next.min}` : "MAX") : String(t.min);
        const sub = cls === "nu" ? "du är här"
          : rp && i === rp.nr - 1 ? "≈ din nivå i Mexiko 🏄" : t.sub;
        return `<div class="niv ${cls}"><span class="pricken">${cls === "klar" ? "✓" : ""}</span>
          <span class="nnamn">${t.name}</span>
          <span class="nsub">${sub}</span>
          <span class="nkrav">${krav}</span></div>`;
      }).join("")}</div>`
    : "";
  const nu = `
    <p class="plabel">Nu<span class="resapil">${resaOpen ? "▴" : "▾"}</span></p>
    <div class="mexrad">
      <div><b>${s.score}</b><span>ord</span></div>
      <div><b>+${nyaIdag(store.data.snapshots, s.score, now)}</b><span>idag</span></div>
      <div><b>${esc(r.titel.name)}</b><span>🏅 nivå ${r.nr} av ${TITLAR.length}</span></div>
    </div>
    <div class="meter resa">
      <i class="seg kan" style="width:${kanPct.toFixed(1)}%"></i><i class="seg lar" style="width:${larPct.toFixed(1)}%"></i>
    </div>
    <div class="resaleg">
      <span><i class="dot kan"></i><b>${s.kan}</b> kan det</span>
      <span><i class="dot pavag"></i><b>${s.lar}</b> på väg</span>
      ${r.next
        ? `<span class="tillnasta"><b>${r.kvar}</b> kvar till ${r.next.name}</span>`
        : `<span class="tillnasta">toppen nådd — ¡Maestro!</span>`}
    </div>
    ${trappa}`;

  // --- Resan till Mexiko: statrad + graf, eller väntetexten tills takten finns ---
  let resan: string;
  if (prognos === null || rp === null) {
    resan = `<p class="omtext" style="margin:0">Du har <b>${s.score}</b> ord med dig.
      Prognosen ritas när du övat i ${MIN_DAGAR} dagar.</p>`;
  } else {
    const serie = Object.entries(store.data.snapshots)
      .sort(([a], [b]) => (a < b ? -1 : 1)).slice(-60)
      .map(([, v]) => v.kan + v.lar);
    if (!serie.length || serie[serie.length - 1] !== s.score) serie.push(s.score);

    const W = 300, H = 96, P = 6;
    const idagX = P + (W - 2 * P) * 0.35;
    const slutX = W - P - 14; // plats för surfaren
    const lo = Math.min(...serie, s.score);
    const hi = Math.max(prognos, ...serie, lo + 1);
    const yTop = 12, yBot = H - 12;
    const y = (v: number) => yBot - ((v - lo) / (hi - lo)) * (yBot - yTop);
    const xHist = (i: number) => serie.length > 1 ? P + (i * (idagX - P)) / (serie.length - 1) : idagX;
    const line = serie.map((v, i) => `${i ? "L" : "M"}${xHist(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${idagX.toFixed(1)} ${yBot} L${P} ${yBot} Z`;
    resan = `
    <div class="mexrad">
      <div><b>~${prognos.toLocaleString("sv-SE")}</b><span>ord</span></div>
      <div><b>${dagarKvar(now)}</b><span>dagar kvar</span></div>
      <div><b>${esc(rp.titel.name)}</b><span>🏄 nivå ${rp.nr} av ${TITLAR.length}</span></div>
    </div>
    <svg class="spark" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Ord nu ${s.score}, prognos till Mexikoresan ~${prognos}">
      <line x1="${P}" y1="${yBot}" x2="${W - P}" y2="${yBot}" stroke="var(--line)" stroke-width="1"/>
      <path d="${area}" fill="var(--accent)" opacity="0.12"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M${idagX.toFixed(1)} ${y(s.score).toFixed(1)} L${slutX} ${y(prognos).toFixed(1)}"
            fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 5"
            stroke-linecap="round" opacity="0.75"/>
      <circle cx="${idagX.toFixed(1)}" cy="${y(s.score).toFixed(1)}" r="4"
              fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>
      <circle cx="${slutX}" cy="${y(prognos).toFixed(1)}" r="3.5"
              fill="var(--card)" stroke="var(--accent)" stroke-width="2"/>
      <text x="${slutX + 4}" y="${(y(prognos) + 4.5).toFixed(1)}" font-size="13">🏄</text>
    </svg>
    <div class="sparkcap mexcap"><span>${esc(dagEtikettKort(store))}</span>
      <span class="mitt">idag</span><span>26 dec 2026</span></div>`;
  }

  return `
    <div class="panel resapanel" id="resaPanel" role="button" tabindex="0" aria-expanded="${resaOpen}">
      ${nu}
      <div class="delare"></div>
      <p class="plabel">Resan till Mexiko 🇲🇽</p>
      ${resan}
    </div>`;
}

/** Startetiketten för x-axeln — första snapshot-dagen, "5 aug"-format. */
function dagEtikettKort(store: Store): string {
  const first = Object.keys(store.data.snapshots).sort()[0];
  if (!first) return "start";
  const d = new Date(first);
  return `${d.getDate()} ${["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"][d.getMonth()]}`;
}

function kontoHtml(cloud: CloudUi): string {
  const err = authError ? `<p class="synkfel">${esc(authError)}</p>` : "";
  if (cloud.email) {
    const status =
      cloud.status === "syncing" ? "synkar …"
      : cloud.status === "error" ? `<span class="synkfel">synkfel — datat är säkert lokalt</span>`
      : cloud.lastSyncAt
        ? `synkad ${new Date(cloud.lastSyncAt).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
        : "";
    return `
      <p class="omtext" style="margin:0 0 10px">Inloggad som <b>${esc(cloud.email)}</b>${status ? " · " + status : ""}</p>
      ${cloud.status === "error" ? `<p class="synkfel">${esc(cloud.lastError)}</p>` : ""}
      <button class="btn ghost" id="authOut">Logga ut</button>`;
  }
  if (pendingEmail) {
    return `
      <p class="omtext" style="margin:0 0 10px">Mejl skickat till <b>${esc(pendingEmail)}</b>.
      Skriv koden ur mejlet:</p>
      <div class="authrow">
        <input id="authCode" autocomplete="one-time-code" inputmode="numeric"
               autocapitalize="none" placeholder="6-siffrig kod" aria-label="Engångskod">
        <button class="btn" id="authVerify">Logga in</button>
      </div>${err}
      <button type="button" class="linkbtn" id="authRestart">Byt adress / skicka nytt mejl</button>`;
  }
  return `
    <p class="omtext" style="margin:0 0 10px">Logga in så synkas allt mellan mobil och dator —
    inget lösenord, du får ett mejl.</p>
    <div class="authrow">
      <input id="authEmail" type="email" autocomplete="email" placeholder="din@mejl.se" aria-label="E-postadress">
      <button class="btn" id="authSend">Skicka mejl</button>
    </div>${err}`;
}

/** Hero-kortet: nästa övning i KORT (samma tal som övningen visar), eller klart-läget. */
/** Nivåmärket i hjälten: 🏅 Turista · 133 ord. */
function nivBadge(store: Store): string {
  const s = store.stats();
  const r = resaFor(s.score);
  return `<div class="nivbadge">🏅 <b>${r.titel.name}</b><span class="nivsub"> · ${s.score} ord</span></div>`;
}

/** Portionens innehållsdeklaration — max en rad, inga kösiffror. */
function deklaration(plan: { repKort: number; nyaOrd: number }): string {
  const delar: string[] = [];
  if (plan.repKort > 0) delar.push(`<b>${plan.repKort}</b> ${plan.repKort === 1 ? "repetition" : "repetitioner"}`);
  if (plan.nyaOrd > 0) delar.push(`<b>${plan.nyaOrd}</b> nya ord`);
  return delar.join(" · ");
}

function heroHtml(store: Store, cloud: CloudUi): string {
  const s = store.stats();
  const busy = cloud.status === "syncing";
  // läsförståelsen låses upp vid Turista — kräver inloggning (texten genereras i molnet)
  const lasUpplast = !!cloud.email && s.score >= LAS_UNLOCK;

  // pausad övning? den fortsätts alltid först — där man slutade
  const paused = loadPass();
  if (paused && cloud.email) {
    return `<div class="hero">
      <p class="plabel">Övning pausad</p>
      ${nivBadge(store)}
      <div class="cap">du fortsätter exakt där du slutade</div>
      <button class="btn" id="startBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : "Fortsätt övningen"}</button>
    </div>`;
  }

  if (!cloud.email) {
    return `<div class="hero">
      <p class="plabel">Nästa övning</p>
      ${nivBadge(store)}
      <button class="btn" id="startBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : "Logga in för att öva"}</button>
      <p class="omtext" style="margin:10px 0 0">Inloggning krävs innan du övar — så att allt du lär dig sparas i molnet.</p>
    </div>`;
  }

  const plan = store.portionsPlan();
  const typ: "glosor" | "las" = valdTyp ?? (lasUpplast && store.glosorKlara() ? "las" : "glosor");
  const picker = lasUpplast
    ? `<div class="picker" id="typVal">
        <button type="button" data-typ="glosor" class="${typ === "glosor" ? "on" : ""}">Glosor</button>
        <button type="button" data-typ="las" class="${typ === "las" ? "on" : ""}">Läsövning</button>
      </div>` : "";

  if (typ === "las") {
    return `<div class="hero">
      ${picker}
      <div class="big">📖</div>
      <p class="cap">en text på din nivå · <b>${lasNiva(s.score).anvand}</b> övningsord</p>
      <button class="btn" id="lasBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : "Läs"}</button>
    </div>`;
  }

  const repPct = plan.totalKort > 0 ? (plan.repKort / plan.totalKort) * 100 : 0;
  const mix = plan.totalKort > 0
    ? `<div class="mix">${repPct > 0 ? `<i class="mrep" style="width:${repPct.toFixed(1)}%"></i>` : ""}${repPct < 100 ? `<i class="mny" style="width:${(100 - repPct).toFixed(1)}%"></i>` : ""}</div>`
    : "";
  return `<div class="hero">
    ${picker}
    <div class="big">${plan.totalKort} <small>kort</small></div>
    <p class="cap">${deklaration(plan) || "inget att öva just nu"}</p>
    ${mix}
    <button class="btn" id="startBtn" ${busy || plan.totalKort === 0 ? "disabled" : ""}>${busy ? "Synkar …" : "Öva"}</button>
  </div>`;
}

function streakRowHtml(store: Store): string {
  const act = activityStats(store.data.days);
  const doneToday = (store.data.days[dayKey()] ?? 0) > 0;
  const label = `${act.streak} ${act.streak === 1 ? "dag" : "dagar"} i rad`;
  const hint = doneToday
    ? "säkrad till midnatt"
    : act.streak > 0 ? `öva idag så blir det ${act.streak + 1}` : "öva idag så tänds den";
  return `<div class="streakrow">🔥 <b>${label}</b><span class="sep">·</span><span>${hint}</span></div>`;
}

function dashboardHtml(store: Store, cloud: CloudUi): string {
  // synkfel blockerar övning — då måste det synas direkt, inte först när
  // man klickar på en knapp som inte gör något
  const synkvarning = cloud.email && cloud.status === "error"
    ? `<div class="synkbanner">Synken kom inte fram — dina ord är säkra lokalt, men
        övning är pausad tills den funkar. <button type="button" id="synkFix">Visa konto</button></div>`
    : "";
  return `
    ${synkvarning}
    ${streakRowHtml(store)}
    ${heroHtml(store, cloud)}
    ${cloud.email ? "" : `<div class="panel" id="kontoPanel">
      <p class="plabel">Konto &amp; molnsynk</p>
      ${kontoHtml(cloud)}
    </div>`}
    ${resanPanelHtml(store)}
    <div class="panel">
      <p class="plabel">Övningskalender · 15 veckor</p>
      ${heatmapHtml(store.data.days)}
    </div>`;
}

function settingsHtml(store: Store, cloud: CloudUi): string {
  const niva = store.data.settings.niva ?? "lagom";
  const conf = NIVAER[niva];
  return `
    <div class="panel setting" style="display:block">
      <span class="t">Ambition</span>
      <div class="picker" id="nivaVal" style="margin:10px 0 8px">
        <button type="button" data-niva="lugn" class="${niva === "lugn" ? "on" : ""}">Lugn</button>
        <button type="button" data-niva="lagom" class="${niva === "lagom" ? "on" : ""}">Lagom</button>
        <button type="button" data-niva="ambitios" class="${niva === "ambitios" ? "on" : ""}">Ambitiös</button>
      </div>
      <span class="finstilt">${conf.kort} kort per övning · upp till ${conf.nya} nya ord om dagen</span>
    </div>
    <div class="panel setting">
      <span class="t">Facit — gå vidare automatiskt</span>
      <button type="button" class="tagg${store.data.settings.autoNext ? " on" : ""}" id="autoNextTgl"
        aria-pressed="${store.data.settings.autoNext}">${store.data.settings.autoNext ? "På" : "Av"}</button>
    </div>
    ${store.data.settings.autoNext ? `<div class="panel setting">
      <span class="t">Facit visas — sekunder</span>
      <span class="stepper">
        <button type="button" aria-label="Kortare facittid" id="autoDown">−</button>
        <span class="v">${(store.data.settings.autoMs / 1000).toLocaleString("sv-SE")}</span>
        <button type="button" aria-label="Längre facittid" id="autoUp">+</button>
      </span>
    </div>` : ""}
    <div class="panel" id="kontoPanel">
      <p class="plabel">Konto &amp; molnsynk</p>
      ${kontoHtml(cloud)}
    </div>
    <div class="panel">
      <p class="plabel">Backup</p>
      <div class="mer" style="margin:0">
        <button class="btn ghost" id="exportBtn">Exportera backup</button>
        <button class="btn ghost" id="importBtn">Importera</button>
        <input type="file" id="importFile" accept="application/json" hidden>
      </div>
    </div>
    <details class="om panel">
      <summary>Om Glosa & källor</summary>
      <p class="omtext" style="margin-top:8px">
        Skrivträning på de vanligaste spanska orden med FSRS-schemaläggning och egna
        minnesregler (aldrig AI-genererade). Datat sparas lokalt och synkas till molnet
        när du är inloggad — exportera en backup då och då. Glosa är icke-kommersiell.
        Ordbasen: frekvens &amp; ordklass ur doozan/spanish_data (CC BY-SA,
        OpenSubtitles via hermitdave/FrequencyWords); svenska översättningar ur Lexins
        svensk-spanska lexikon, Institutet för språk och folkminnen (CC BY 4.0); genus
        ur en.wiktionary (CC BY-SA); verbböjningar ur Fred Jehles verbdatabas
        (CC BY-NC-SA 3.0); exempelmeningar ur Tatoeba (CC BY 2.0 FR).
      </p>
    </details>`;
}

export function renderIdag(el: HTMLElement, store: Store, cb: IdagCallbacks, cloud: CloudUi): void {
  el.innerHTML = `
    <div class="idag">
      <div class="apphead">
        <span class="brand">Glosa<i>.</i></span>
        <span class="ahright">
          <span class="date">${esc(fmtDate())}</span>
          <button type="button" class="gearbtn${settingsOpen ? " on" : ""}" id="gearBtn"
            aria-label="${settingsOpen ? "Tillbaka" : "Inställningar"}">${IC_GEAR}</button>
        </span>
      </div>
      ${settingsOpen ? settingsHtml(store, cloud) : dashboardHtml(store, cloud)}
    </div>`;

  const rerender = () => renderIdag(el, store, cb, cloud);

  el.querySelector<HTMLButtonElement>("#synkFix")?.addEventListener("click", () => {
    settingsOpen = true;
    rerender();
  });
  el.querySelector<HTMLButtonElement>("#gearBtn")!.onclick = () => {
    settingsOpen = !settingsOpen;
    rerender();
  };
  el.querySelector<HTMLButtonElement>("#startBtn")?.addEventListener("click", () => cb.startPass());
  el.querySelector<HTMLButtonElement>("#lasBtn")?.addEventListener("click", () => cb.startLas());
  el.querySelectorAll<HTMLButtonElement>("#typVal [data-typ]").forEach((b) =>
    b.addEventListener("click", () => {
      valdTyp = b.dataset.typ as "glosor" | "las";
      rerender();
    }));
  el.querySelectorAll<HTMLButtonElement>("#nivaVal [data-niva]").forEach((b) =>
    b.addEventListener("click", () => {
      store.setNiva(b.dataset.niva as Niva);
      rerender();
    }));
  el.querySelector<HTMLElement>("#resaPanel")?.addEventListener("click", () => {
    resaOpen = !resaOpen;
    rerender();
  });
  el.querySelector<HTMLButtonElement>("#autoNextTgl")?.addEventListener("click", () => {
    store.setAutoNext(!store.data.settings.autoNext);
    rerender();
  });
  const bumpAuto = (d: number) => {
    store.setAutoMs(store.data.settings.autoMs + d * 500); // halvsekundssteg, 1–10 s
    rerender();
  };
  el.querySelector<HTMLButtonElement>("#autoDown")?.addEventListener("click", () => bumpAuto(-1));
  el.querySelector<HTMLButtonElement>("#autoUp")?.addEventListener("click", () => bumpAuto(1));

  el.querySelector<HTMLButtonElement>("#exportBtn")?.addEventListener("click", () => {
    const url = URL.createObjectURL(exportBlob(store.data));
    const a = document.createElement("a");
    a.href = url;
    a.download = `glosa-backup-${dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  // ----- konto & synk -----
  const busy = (b: HTMLButtonElement, on: boolean) => { b.disabled = on; };
  el.querySelector<HTMLButtonElement>("#authSend")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const email = el.querySelector<HTMLInputElement>("#authEmail")!.value.trim();
    if (!email.includes("@")) { authError = "Skriv en giltig e-postadress."; rerender(); return; }
    busy(btn, true);
    try {
      await cloud.sendCode(email);
      pendingEmail = email;
      authError = "";
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }
    rerender();
  });
  el.querySelector<HTMLButtonElement>("#authVerify")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const code = el.querySelector<HTMLInputElement>("#authCode")!.value.trim();
    if (!code) return;
    busy(btn, true);
    try {
      await cloud.verifyCode(pendingEmail, code);
      pendingEmail = "";
      authError = "";
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
      busy(btn, false);
    }
    rerender();
  });
  el.querySelector<HTMLInputElement>("#authCode")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.querySelector<HTMLButtonElement>("#authVerify")!.click();
  });
  el.querySelector<HTMLButtonElement>("#authRestart")?.addEventListener("click", () => {
    pendingEmail = ""; authError = ""; rerender();
  });
  el.querySelector<HTMLButtonElement>("#authOut")?.addEventListener("click", () => { void cloud.signOut(); });

  const fileInput = el.querySelector<HTMLInputElement>("#importFile");
  const importBtn = el.querySelector<HTMLButtonElement>("#importBtn");
  if (fileInput && importBtn) {
    importBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const data = parseImport(await f.text());
        if (confirm("Ersätt all lokal inlärningsdata med backupen?")) {
          new LocalStorageAdapter().save(data);
          location.reload();
        }
      } catch (e) {
        alert(String(e instanceof Error ? e.message : e));
      }
    };
  }
}
