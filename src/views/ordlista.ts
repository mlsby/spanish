import type { Social } from "../lib/social";
import type { Store, WordStatus } from "../lib/store";
import type { CardRec, Level } from "../lib/types";
import { LEVEL_SV, POS_LABEL } from "../lib/types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PAGE = 100;

const LEVELS: Level[] = ["ny", "ovar", "pagang", "kan"];

/** Bekräftelseraden under stegen direkt efter en flytt. */
const MOVED_MSG: Record<Level, string> = {
  ny: "Ordet börjar om — kommer som nytt i passet.",
  ovar: "Läggs i dagens pass.",
  pagang: "På gång — kollas om 14 dagar.",
  kan: "Kan det — kollas om 30 dagar.",
};

export function renderOrdlista(el: HTMLElement, store: Store, social?: Social): void {
  let query = "";
  let shown = PAGE;
  let openId: string | null = null;
  let moved: { id: string; text: string } | null = null;
  /** senaste snabbmarkeringen — bär ögonblicksbilden som ångra återställer */
  let undo: { id: string; snap: (CardRec | null)[]; timer: number } | null = null;

  function dropUndo(): void {
    if (undo) window.clearTimeout(undo.timer);
    undo = null;
  }

  el.innerHTML = `
    <div class="lista">
      <label class="search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="searchInput" type="search" placeholder="Sök bland ${store.words.length} ord …" aria-label="Sök ord">
      </label>
      <div class="rows" id="rows"></div>
      <button class="btn ghost visafler" id="moreBtn" hidden>Visa fler</button>
    </div>`;

  const rowsEl = el.querySelector<HTMLElement>("#rows")!;
  const moreBtn = el.querySelector<HTMLButtonElement>("#moreBtn")!;
  const searchEl = el.querySelector<HTMLInputElement>("#searchInput")!;

  function matching(): WordStatus[] {
    const q = query.toLowerCase();
    const out: WordStatus[] = [];
    for (const w of store.words) {
      if (q && !w.es.toLowerCase().includes(q) && !w.sv.toLowerCase().includes(q)) continue;
      out.push(store.wordStatus(w));
    }
    return out;
  }

  /** Verbets böjningsformer med status-prick (grå = inte introducerad än). */
  function formsHtml(wordId: string): string {
    const forms = store.formsByParent.get(wordId);
    if (!forms?.length) return "";
    const chips = [...forms].sort((a, b) => a.r - b.r).map((f) => {
      const a = store.card(f.id, "es2sv");
      const b = store.card(f.id, "sv2es");
      const cls = a && b && [a, b].every((c) => c.fsrs.stability >= 30) ? "kan" : a || b ? "lar" : "ny";
      return `<span class="syn formchip" title="${esc(f.svPres)}"><i class="dot ${cls}"></i>${esc(f.es)}</span>`;
    }).join("");
    return `<div><div class="xl">Böjningar · presens</div><div class="syns">${chips}</div></div>`;
  }

  /** Radens miniatyr: fyra prickar ifyllda till nuvarande nivå. */
  function pathHtml(ws: WordStatus): string {
    const fill = ws.level === "ny" ? 0
      : ws.level === "ovar" ? (ws.minStability < 1 ? 1 : 2)
      : ws.level === "pagang" ? 3 : 4;
    const dots = LEVELS.map((_, i) => `<i class="${i < fill ? `f-${ws.level}` : ""}"></i>`).join("");
    return `<span class="lpath" aria-label="nivå: ${LEVEL_SV[ws.level]}">${dots}</span>`;
  }

  /** Den tryckbara stegen i expansionen — tryck på ett steg för att flytta ordet. */
  function stegeHtml(ws: WordStatus): string {
    const cur = LEVELS.indexOf(ws.level);
    const stops = LEVELS.map((lvl, i) => {
      const cls = i === cur ? " on" : i < cur ? " past" : "";
      return `${i ? '<span class="leg"></span>' : ""}
        <button type="button" class="steg${cls}" data-setlvl="${lvl}"
          aria-pressed="${i === cur}"><i></i><span>${LEVEL_SV[lvl]}</span></button>`;
    }).join("");
    const tip = moved?.id === ws.word.id
      ? `<p class="stegtips flyttad">${esc(moved.text)}</p>`
      : `<p class="stegtips">tryck på ett steg för att flytta ordet</p>`;
    return `<div class="stege">${stops}</div>${tip}`;
  }

  function rowHtml(ws: WordStatus): string {
    const { word } = ws;
    const uw = store.userWord(word.id);
    const open = word.id === openId;
    const es = word.art ? `${word.art} ${word.es}` : word.es;
    const baseSyns = word.syn.map((s) => `<span class="syn">${esc(s)}</span>`).join("");
    const ownSyns = uw.syn
      .map((s) => `<button class="syn egen" data-delsyn="${esc(s)}" title="Ta bort">${esc(s)} ×</button>`)
      .join("");
    const known = ws.level === "kan";
    return `
      <div class="row${open ? " open" : ""}" data-id="${esc(word.id)}">
        <div class="rowline">
          <button type="button" class="rowbtn" aria-expanded="${open}">
            <span class="es">${esc(es)}</span><span class="sv">${esc(word.sv)}</span>
            <span class="meta">
              ${uw.mnem ? `<span class="chip-regel">regel</span>` : ""}
              ${pathHtml(ws)}
            </span>
          </button>
          <button type="button" class="qmark${known ? " done" : ""}" data-qmark
            aria-pressed="${known}" aria-label="${known ? "Markerad: kan det" : "Markera: kan det"}">✓</button>
        </div>
        ${undo?.id === word.id
          ? `<div class="qstrip">Kan det — kollas om 30 dagar ·
              <button type="button" data-qundo>ångra</button></div>` : ""}
        <div class="rowx">
          ${stegeHtml(ws)}
          <div><div class="xl">${esc(POS_LABEL[word.pos] ?? word.pos)}</div>
            ${word.hint ? `<p class="omtext" style="margin:4px 0 0">Ledtråd: <i>(${esc(word.hint)})</i></p>` : ""}
            ${word.alt?.length ? `<p class="omtext" style="margin:4px 0 0">Accepteras även: ${word.alt.map(esc).join(", ")}</p>` : ""}</div>
          <div><div class="xl">Synonymer</div>
            <div class="syns">${baseSyns}${ownSyns}
              <input type="text" data-addsyn placeholder="+ lägg till" aria-label="Lägg till synonym"></div></div>
          ${formsHtml(word.id)}
          <div><div class="xl">Minnesregel — din egen</div>
            <textarea data-mnem aria-label="Minnesregel"
              placeholder="Skriv något som får ordet att fastna …">${esc(uw.mnem)}</textarea></div>
          <div class="frules" data-frw="${esc(word.id)}"></div>
          <button type="button" class="mini" data-savemnem>Spara</button>
        </div>
      </div>`;
  }

  function renderRows(): void {
    const list = matching();
    rowsEl.innerHTML = list.slice(0, shown).map(rowHtml).join("");
    moreBtn.hidden = list.length <= shown;
    moreBtn.textContent = `Visa fler (${Math.max(0, list.length - shown)} kvar)`;
  }

  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim();
    shown = PAGE;
    moved = null;
    renderRows();
  });
  moreBtn.addEventListener("click", () => {
    shown += PAGE;
    renderRows();
  });

  rowsEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(".row");
    if (!row) return;
    const id = row.dataset.id!;
    const qm = t.closest<HTMLElement>("[data-qmark]");
    if (qm) {
      const w = store.byId.get(id);
      if (!w || store.wordStatus(w).level === "kan") return; // redan där
      dropUndo();
      const snap = store.cardSnapshot(id);
      store.setLevel(id, "kan");
      const timer = window.setTimeout(() => {
        if (undo?.id !== id) return;
        undo = null;
        // rita inte om mitt i skrivande — remsan får ligga kvar tills nästa rendering
        const a = document.activeElement;
        if (a && rowsEl.contains(a) && a.matches("input,textarea")) return;
        renderRows();
      }, 6000);
      undo = { id, snap, timer };
      moved = null;
      renderRows();
      return;
    }
    if (t.closest("[data-qundo]") && undo) {
      store.restoreCards(undo.id, undo.snap);
      dropUndo();
      renderRows();
      return;
    }
    const steg = t.closest<HTMLElement>("[data-setlvl]");
    if (steg) {
      const lvl = steg.dataset.setlvl as Level;
      const w = store.byId.get(id);
      if (lvl === "ny" && !window.confirm(`Nollställa "${w?.es ?? id}"? Ordet börjar om från Ny.`)) return;
      store.setLevel(id, lvl);
      moved = { id, text: MOVED_MSG[lvl] };
      renderRows();
      return;
    }
    const del = t.closest<HTMLElement>("[data-delsyn]");
    if (del) {
      store.removeUserSyn(id, del.dataset.delsyn!);
      renderRows();
      return;
    }
    if (t.closest("[data-savemnem]")) {
      const ta = row.querySelector<HTMLTextAreaElement>("[data-mnem]")!;
      store.setMnem(id, ta.value);
      renderRows();
      return;
    }
    if (t.closest("textarea,input")) return;
    if (t.closest(".rowbtn")) {
      openId = openId === id ? null : id;
      moved = null;
      renderRows();
      if (openId === id) loadFriendRules(id);
    }
  });

  /** Kompisarnas regler hämtas i bakgrunden när en rad öppnas. */
  function loadFriendRules(id: string): void {
    if (!social) return;
    void social.friendRules(id).then((rules) => {
      const wrap = rowsEl.querySelector<HTMLElement>(`[data-frw="${CSS.escape(id)}"]`);
      if (!wrap || !rules.length) return;
      wrap.innerHTML =
        `<div class="frt">Kompisarnas regler</div>` +
        rules.map((r) =>
          `<div class="frq"><span class="who">${esc(r.name)}</span><span class="q">"${esc(r.mnem)}"</span></div>`
        ).join("");
    });
  }
  rowsEl.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.matches("[data-addsyn]")) {
      e.preventDefault();
      const input = t as HTMLInputElement;
      const row = input.closest<HTMLElement>(".row")!;
      store.addUserSyn(row.dataset.id!, input.value);
      renderRows();
    }
  });

  renderRows();
}
