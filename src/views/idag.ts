import { loadPass } from "../lib/passpaus";
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

function sparklineHtml(snapshots: Record<string, { kan: number; lar: number }>): string {
  const entries = Object.entries(snapshots).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-60);
  if (entries.length < 2) {
    return `<p class="omtext" style="margin:0">Grafen ritas när du övat ett par dagar.</p>`;
  }
  const vals = entries.map(([, v]) => v.kan);
  const min = Math.min(...vals), max = Math.max(...vals, min + 1);
  const W = 300, H = 84, P = 6;
  const x = (i: number) => P + (i * (W - 2 * P)) / (vals.length - 1);
  const y = (v: number) => H - 14 - ((v - min) / (max - min)) * (H - 26);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(vals.length - 1).toFixed(1)} ${H - 8} L${x(0).toFixed(1)} ${H - 8} Z`;
  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Antal ord med status Kan det över tid, nu ${vals[vals.length - 1]}">
      <line x1="${P}" y1="${H - 8}" x2="${W - P}" y2="${H - 8}" stroke="var(--line)" stroke-width="1"/>
      <path d="${area}" fill="var(--accent)" opacity="0.12"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(vals.length - 1)}" cy="${y(vals[vals.length - 1])}" r="4"
              fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>
    </svg>
    <div class="sparkcap"><span>${esc(entries[0][0].slice(5))}</span>
      <span>idag · ${vals[vals.length - 1]}</span></div>`;
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
      Håll inne inloggningslänken i mejlet → <b>Kopiera länk</b> → klistra in här
      (eller skriv engångskoden om mejlet har en):</p>
      <div class="authrow">
        <input id="authCode" autocomplete="one-time-code" autocapitalize="none"
               placeholder="inklistrad länk eller kod" aria-label="Inloggningslänk eller engångskod">
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
  const r = resaFor(store.stats().kan);
  return `<div class="nivbadge">🏅 <b>${r.titel.name}</b><span class="nivsub"> · ${store.stats().kan} ord</span></div>`;
}

function heroHtml(store: Store, cloud: CloudUi): string {
  const s = store.stats();
  const doneToday = store.data.days[dayKey()] ?? 0;
  const busy = cloud.status === "syncing";

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
    </div>`;
  }

  return `<div class="hero">
    <p class="plabel">${plabel}</p>
    ${nivBadge(store)}
    <button class="btn" id="startBtn" ${busy ? "disabled" : ""}>${busy ? "Synkar …" : cta}</button>
    ${s.due > 0
      ? `<div class="ghostrow"><button class="btn ghost" id="repBtn" ${busy ? "disabled" : ""}>Repetera</button></div>`
      : ""}
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

/** Nivåresan: färgad bar mot NÄSTA tröskel — grönt = kan, gult = lär mig. */
function resaPanelHtml(s: { kan: number; lar: number }): string {
  const r = resaFor(s.kan);
  const scale = r.next ? r.next.min : Math.max(s.kan, TITLAR[TITLAR.length - 1].min);
  const kanPct = Math.min(100, (s.kan / scale) * 100);
  const larPct = Math.min(100 - kanPct, (s.lar / scale) * 100);
  return `
    <div class="panel">
      <p class="plabel">Din resa · nivå ${r.nr} av ${TITLAR.length}</p>
      <div class="nivrow">🏅 <b>${r.titel.name}</b><span class="nivsub">${r.titel.sub}</span></div>
      <div class="meter resa">
        <i class="seg kan" style="width:${kanPct.toFixed(1)}%"></i><i class="seg lar" style="width:${larPct.toFixed(1)}%"></i>
      </div>
      <div class="resaleg">
        <span><i class="dot kan"></i><b>${s.kan}</b> kan det</span>
        <span><i class="dot lar"></i><b>${s.lar}</b> lär mig</span>
        ${r.next
          ? `<span class="tillnasta"><b>${r.kvar}</b> kvar till ${r.next.name}</span>`
          : `<span class="tillnasta">toppen nådd — ¡Maestro!</span>`}
      </div>
    </div>`;
}

function dashboardHtml(store: Store, cloud: CloudUi): string {
  const s = store.stats();
  return `
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
      <p class="plabel">Kan det · över tid</p>
      ${sparklineHtml(store.data.snapshots)}
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

  el.querySelector<HTMLButtonElement>("#gearBtn")!.onclick = () => {
    settingsOpen = !settingsOpen;
    rerender();
  };
  el.querySelector<HTMLButtonElement>("#startBtn")?.addEventListener("click", () => cb.startPass());
  el.querySelector<HTMLButtonElement>("#repBtn")?.addEventListener("click", () => cb.startRep());

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
