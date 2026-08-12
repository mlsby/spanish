import { LAS_UNLOCK } from "../lib/lastext";
import { loadPass } from "../lib/passpaus";
import { dagarKvar, MIN_DAGAR, prognosOrd, taktPerDag } from "../lib/prognos";
import { resaFor, TITLAR } from "../lib/resa";
import type { Store } from "../lib/store";
import { exportBlob, parseImport, LocalStorageAdapter } from "../lib/storage";
import { activityStats } from "../lib/streak";
import { addDays, dayKey, fmtDate, weekdayMon } from "../lib/time";
import type { SyncStatus } from "../lib/sync";

export interface IdagCallbacks {
  startPass(): void;
  /** bara repetitioner — inga nya ord (flyktvägen för trötta dagar) */
  startRep(): void;
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

/** Mexiko-grafen: historiken (kan + på gång) till idag, streckad prognos till resan. */
function mexikoHtml(store: Store): string {
  const now = new Date();
  const score = store.stats().score;
  const kvar = dagarKvar(now);
  const takt = taktPerDag(Object.values(store.data.cards), now);
  if (!takt) {
    return `<p class="omtext" style="margin:0">Du har <b>${score}</b> ord med dig.
      Prognosen ritas när du övat i ${MIN_DAGAR} dagar.</p>`;
  }
  const prognos = prognosOrd(score, takt, now, store.words.length + store.forms.length);
  const niva = resaFor(prognos).titel.name;
  const serie = Object.entries(store.data.snapshots)
    .sort(([a], [b]) => (a < b ? -1 : 1)).slice(-60)
    .map(([, v]) => v.kan + v.lar);
  if (!serie.length || serie[serie.length - 1] !== score) serie.push(score);

  const W = 300, H = 96, P = 6;
  const idagX = P + (W - 2 * P) * 0.35;
  const slutX = W - P - 14; // plats för kaktusen
  const lo = Math.min(...serie, score);
  const hi = Math.max(prognos, ...serie, lo + 1);
  const yTop = 12, yBot = H - 12;
  const y = (v: number) => yBot - ((v - lo) / (hi - lo)) * (yBot - yTop);
  const xHist = (i: number) => serie.length > 1 ? P + (i * (idagX - P)) / (serie.length - 1) : idagX;
  const line = serie.map((v, i) => `${i ? "L" : "M"}${xHist(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${idagX.toFixed(1)} ${yBot} L${P} ${yBot} Z`;
  const taktStr = (Math.round(takt.perDag * 10) / 10).toLocaleString("sv-SE");
  return `
    <div class="mexrad">
      <div><b>${score}</b><span>ord nu</span></div>
      <div><b>~${prognos.toLocaleString("sv-SE")}</b><span>i Mexiko · ≈ ${esc(niva)}</span></div>
    </div>
    <svg class="spark" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Ord nu ${score}, prognos till Mexikoresan ~${prognos}">
      <line x1="${P}" y1="${yBot}" x2="${W - P}" y2="${yBot}" stroke="var(--line)" stroke-width="1"/>
      <path d="${area}" fill="var(--accent)" opacity="0.12"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M${idagX.toFixed(1)} ${y(score).toFixed(1)} L${slutX} ${y(prognos).toFixed(1)}"
            fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 5"
            stroke-linecap="round" opacity="0.75"/>
      <circle cx="${idagX.toFixed(1)}" cy="${y(score).toFixed(1)}" r="4"
              fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>
      <circle cx="${slutX}" cy="${y(prognos).toFixed(1)}" r="3.5"
              fill="var(--card)" stroke="var(--accent)" stroke-width="2"/>
      <text x="${slutX + 4}" y="${(y(prognos) + 4.5).toFixed(1)}" font-size="13">🏄</text>
    </svg>
    <div class="sparkcap mexcap"><span>${esc(dagEtikettKort(store))}</span>
      <span class="mitt">idag</span><span>26 dec 2026</span></div>
    <p class="omtext" style="margin:7px 0 0">~${taktStr} nya ord/dag senaste ${takt.dagar} dagarna
      · ${kvar} dagar kvar till avresan</p>`;
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

function heroHtml(store: Store, cloud: CloudUi): string {
  const s = store.stats();
  const doneToday = store.data.days[dayKey()] ?? 0;
  const busy = cloud.status === "syncing";
  // läsförståelsen låses upp vid Turista — kräver inloggning (texten genereras i molnet)
  const lasBtn = cloud.email && s.score >= LAS_UNLOCK
    ? `<button class="btn ghost" id="lasBtn" ${busy ? "disabled" : ""}>Läs en text</button>` : "";

  // pausad övning? den fortsätts alltid först — där man slutade
  const paused = loadPass();
  if (paused && cloud.email) {
    return `<div class="hero">
      <p class="plabel">Övning pausad</p>
      ${nivBadge(store)}
      <div class="cap">du fortsätter exakt där du slutade</div>
      <button class="btn" id="startBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : "Fortsätt övningen"}</button>
      <div class="ghostrow"><button class="btn ghost" id="repBtn" ${busy || !s.repAvailable ? "disabled" : ""}>Repetera</button>${lasBtn}</div>
    </div>`;
  }

  const total = s.due + s.nextNew;
  const plabel = s.firstToday ? "Dagens övning" : "Öva mer";
  const cta = s.firstToday ? "Starta dagens övning" : "Öva mer";

  if (!cloud.email) {
    return `<div class="hero">
      <p class="plabel">${plabel}</p>
      ${nivBadge(store)}
      <button class="btn" id="startBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : "Logga in för att öva"}</button>
      <p class="omtext" style="margin:10px 0 0">Inloggning krävs innan du övar — så att allt du lär dig sparas i molnet.</p>
    </div>`;
  }

  if (total === 0) {
    return `<div class="hero klar">
      <p class="plabel">Dagens övning</p>
      ${nivBadge(store)}
      <div class="klartxt">✓ Klart för idag</div>
      <div class="cap">${doneToday > 0 ? `<b>${doneToday}</b> kort idag — streaken säkrad` : "inget förfallet just nu"}</div>
      <div class="ghostrow"><button class="btn ghost" id="repBtn" ${busy || !s.repAvailable ? "disabled" : ""}>Repetera</button>${lasBtn}</div>
    </div>`;
  }

  return `<div class="hero">
    <p class="plabel">${plabel}</p>
    ${nivBadge(store)}
    <button class="btn" id="startBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : cta}</button>
    <div class="ghostrow"><button class="btn ghost" id="repBtn" ${busy || !s.repAvailable ? "disabled" : ""}>Repetera</button>${lasBtn}</div>
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

/** Nivåresan: färgad bar mot NÄSTA tröskel — tryck på panelen fäller ut hela trappan. */
function resaPanelHtml(s: { kan: number; lar: number; score: number }): string {
  const r = resaFor(s.score);
  const scale = r.next ? r.next.min : Math.max(s.score, TITLAR[TITLAR.length - 1].min);
  const kanPct = Math.min(100, (s.kan / scale) * 100);
  const larPct = Math.min(100 - kanPct, (s.lar / scale) * 100);
  const trappa = resaOpen
    ? `<div class="trappa">${TITLAR.map((t, i) => {
        const cls = i < r.nr - 1 ? "klar" : i === r.nr - 1 ? "nu" : "last";
        const krav = cls === "nu" ? (r.next ? `${s.score}/${r.next.min}` : "MAX") : String(t.min);
        return `<div class="niv ${cls}"><span class="pricken">${cls === "klar" ? "✓" : ""}</span>
          <span class="nnamn">${t.name}</span>
          <span class="nsub">${cls === "nu" ? "du är här" : t.sub}</span>
          <span class="nkrav">${krav}</span></div>`;
      }).join("")}</div>`
    : "";
  return `
    <div class="panel resapanel" id="resaPanel" role="button" tabindex="0" aria-expanded="${resaOpen}">
      <p class="plabel">Din resa · nivå ${r.nr} av ${TITLAR.length}<span class="resapil">${resaOpen ? "▴" : "▾"}</span></p>
      <div class="nivrow">🏅 <b>${r.titel.name}</b><span class="nivsub">${r.titel.sub}</span></div>
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
      ${trappa}
    </div>`;
}

function dashboardHtml(store: Store, cloud: CloudUi): string {
  const s = store.stats();
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
    ${resaPanelHtml(s)}
    <div class="panel">
      <p class="plabel">Övningskalender · 15 veckor</p>
      ${heatmapHtml(store.data.days)}
    </div>
    <div class="panel">
      <p class="plabel">Resan till Mexiko 🇲🇽</p>
      ${mexikoHtml(store)}
    </div>`;
}

function settingsHtml(store: Store, cloud: CloudUi): string {
  return `
    <div class="panel setting">
      <span class="t">Nya ord — dagens första övning</span>
      <span class="stepper">
        <button type="button" aria-label="Färre nya ord i första övningen" id="firstDown">−</button>
        <span class="v">${store.data.settings.newFirst}</span>
        <button type="button" aria-label="Fler nya ord i första övningen" id="firstUp">+</button>
      </span>
    </div>
    <div class="panel setting">
      <span class="t">Nya ord — per "Öva mer"</span>
      <span class="stepper">
        <button type="button" aria-label="Färre nya ord per extra övning" id="moreDown">−</button>
        <span class="v">${store.data.settings.newMore}</span>
        <button type="button" aria-label="Fler nya ord per extra övning" id="moreUp">+</button>
      </span>
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
  el.querySelector<HTMLButtonElement>("#repBtn")?.addEventListener("click", () => cb.startRep());
  el.querySelector<HTMLButtonElement>("#lasBtn")?.addEventListener("click", () => cb.startLas());
  el.querySelector<HTMLElement>("#resaPanel")?.addEventListener("click", () => {
    resaOpen = !resaOpen;
    rerender();
  });

  const bumpFirst = (d: number) => {
    store.setNewFirst(Math.max(0, Math.min(50, store.data.settings.newFirst + d)));
    rerender();
  };
  const bumpMore = (d: number) => {
    store.setNewMore(Math.max(0, Math.min(20, store.data.settings.newMore + d)));
    rerender();
  };
  el.querySelector<HTMLButtonElement>("#firstDown")?.addEventListener("click", () => bumpFirst(-1));
  el.querySelector<HTMLButtonElement>("#firstUp")?.addEventListener("click", () => bumpFirst(1));
  el.querySelector<HTMLButtonElement>("#moreDown")?.addEventListener("click", () => bumpMore(-1));
  el.querySelector<HTMLButtonElement>("#moreUp")?.addEventListener("click", () => bumpMore(1));
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
