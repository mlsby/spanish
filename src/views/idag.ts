import type { Store } from "../lib/store";
import { exportBlob, parseImport, LocalStorageAdapter } from "../lib/storage";
import { addDays, dayKey, fmtDate, weekdayMon } from "../lib/time";

export interface IdagCallbacks {
  startPass(includeNew: boolean): void;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
        `<div class="d ${heatClass(n)}${isToday ? " idag" : ""}${future ? " framtid" : ""}"` +
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

export function renderIdag(el: HTMLElement, store: Store, cb: IdagCallbacks): void {
  const s = store.stats();
  const totalToday = s.due + s.newAvailable;
  el.innerHTML = `
    <div class="idag">
      <div class="apphead">
        <span class="brand">Glosa<i>.</i></span>
        <span class="date">${esc(fmtDate())}</span>
      </div>

      <div class="hero">
        <div class="big">${totalToday}</div>
        <div class="cap"><b>${s.due}</b> repetitioner · <b>${s.newAvailable}</b> nya ord</div>
        <button class="btn" id="startFull" ${totalToday === 0 ? "disabled" : ""}>Starta dagens pass</button>
        <button class="btn ghost" id="startRep" ${s.due === 0 ? "disabled" : ""}>Bara repetitioner (${s.due})</button>
      </div>

      <div class="statrow">
        <div class="stat"><div class="n">${s.ny}</div><div class="l"><span class="dot ny"></span>Nya</div></div>
        <div class="stat"><div class="n">${s.lar}</div><div class="l"><span class="dot lar"></span>Lär mig</div></div>
        <div class="stat"><div class="n">${s.kan}</div><div class="l"><span class="dot kan"></span>Kan det</div></div>
      </div>

      <div class="panel">
        <p class="plabel">Progression · mål ${s.goal.toLocaleString("sv-SE")} ord</p>
        <div class="meter"><i style="width:${Math.min(100, (s.started / s.goal) * 100).toFixed(2)}%"></i></div>
        <div class="metercap"><span>${s.started} påbörjade · ${s.kan} kan</span><span>${s.total.toLocaleString("sv-SE")} i basen</span></div>
      </div>

      <div class="panel">
        <p class="plabel">Övningskalender · 15 veckor</p>
        ${heatmapHtml(store.data.days)}
      </div>

      <div class="panel">
        <p class="plabel">Kan det · över tid</p>
        ${sparklineHtml(store.data.snapshots)}
      </div>

      <div class="panel setting">
        <span class="t">Nya ord per dag</span>
        <span class="stepper">
          <button type="button" aria-label="Färre nya ord" id="paceDown">−</button>
          <span class="v" id="paceVal">${store.data.settings.newPerDay}</span>
          <button type="button" aria-label="Fler nya ord" id="paceUp">+</button>
        </span>
      </div>

      <div class="mer">
        <button class="btn ghost" id="exportBtn">Exportera backup</button>
        <button class="btn ghost" id="importBtn">Importera</button>
        <input type="file" id="importFile" accept="application/json" hidden>
      </div>

      <details class="om panel">
        <summary>Om Glosa & källor</summary>
        <p class="omtext" style="margin-top:8px">
          Skrivträning på de vanligaste spanska orden med FSRS-schemaläggning och egna
          minnesregler (aldrig AI-genererade). Datat sparas lokalt i webbläsaren i v1 —
          exportera en backup då och då. Ordbasen: frekvens &amp; ordklass ur
          doozan/spanish_data (CC BY-SA, OpenSubtitles via hermitdave/FrequencyWords);
          svenska översättningar ur Lexins svensk-spanska lexikon,
          Institutet för språk och folkminnen (CC BY 4.0); genus ur en.wiktionary (CC BY-SA).
        </p>
      </details>
    </div>`;

  el.querySelector<HTMLButtonElement>("#startFull")!.onclick = () => cb.startPass(true);
  el.querySelector<HTMLButtonElement>("#startRep")!.onclick = () => cb.startPass(false);

  const paceVal = el.querySelector<HTMLElement>("#paceVal")!;
  const bump = (d: number) => {
    const v = Math.max(0, Math.min(50, store.data.settings.newPerDay + d));
    store.data.settings.newPerDay = v;
    store.save();
    paceVal.textContent = String(v);
    renderIdag(el, store, cb); // uppdatera "nya ord"-siffrorna
  };
  el.querySelector<HTMLButtonElement>("#paceDown")!.onclick = () => bump(-1);
  el.querySelector<HTMLButtonElement>("#paceUp")!.onclick = () => bump(1);

  el.querySelector<HTMLButtonElement>("#exportBtn")!.onclick = () => {
    const url = URL.createObjectURL(exportBlob(store.data));
    const a = document.createElement("a");
    a.href = url;
    a.download = `glosa-backup-${dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const fileInput = el.querySelector<HTMLInputElement>("#importFile")!;
  el.querySelector<HTMLButtonElement>("#importBtn")!.onclick = () => fileInput.click();
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
