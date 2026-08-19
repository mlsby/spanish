import type { Social } from "../lib/social";
import type { Store, WordStatus } from "../lib/store";
import { isKnown } from "../lib/scheduler";
import type { CardRec, Level, VerbForm, Word } from "../lib/types";
import { LEVEL_SV, PERSON_SV, POS_LABEL } from "../lib/types";
import {
  antalFilter, dagEtikett, felAntal, filtreraLista, introAt, type ListFilter,
  type PosGrupp, type RegelFilter, SORT_SV, sorteraLista, type SortKey,
} from "../lib/listning";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PAGE = 100;

const LEVELS: Level[] = ["ny", "ovar", "pagang", "kan"];

/** Bekräftelseraden under stegen direkt efter en flytt. */
const MOVED_MSG: Record<Level, string> = {
  ny: "Ordet börjar om — kommer som nytt i passet.",
  ovar: "Läggs i dagens pass.",
  pagang: "På gång — kollas om 14 dagar.",
  kan: "Kan det — kollas om 21 dagar.",
};

const LISTA_KEY = "glosa.lista.v1";

interface ListaVal { sort: SortKey; niva: Level[]; regler: RegelFilter[]; pos: PosGrupp[] }

function loadVal(): ListaVal {
  try {
    const raw = localStorage.getItem(LISTA_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      return { sort: v.sort ?? "vanligast", niva: v.niva ?? [], regler: v.regler ?? [], pos: v.pos ?? [] };
    }
  } catch { /* börja från standardläget */ }
  return { sort: "vanligast", niva: [], regler: [], pos: [] };
}

const IKON_SORT = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M8 5v14M8 19l-3.5-4M8 19l3.5-4M16 19V5M16 5l-3.5 4M16 5l3.5 4"/></svg>`;
const IKON_FILTER = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M4 5h16l-6.5 7.5v5L10.5 20v-7.5L4 5z"/></svg>`;

/** Böjning som listbart "ord": rank = korpus-slot, sv = "vi pratar". */
function formAsWord(f: VerbForm): Word {
  return {
    id: f.id, rank: f.slot, es: f.es, pos: "vform",
    sv: `${PERSON_SV[f.person]} ${f.svPres}`, syn: [],
  };
}

export function renderOrdlista(el: HTMLElement, store: Store, social?: Social): void {
  let query = "";
  let shown = PAGE;
  let openId: string | null = null;
  let moved: { id: string; text: string } | null = null;
  /** senaste snabbmarkeringen — bär ögonblicksbilden som ångra återställer */
  let undo: { id: string; snap: (CardRec | null)[]; timer: number } | null = null;
  const val = loadVal();
  let sheet: "sort" | "filter" | null = null;
  /** ord-id → kompisarnas namn (fylls i bakgrunden efter en klumpfråga) */
  let marks = new Map<string, string[]>();
  let lastTotal = 0;

  function saveVal(): void {
    try { localStorage.setItem(LISTA_KEY, JSON.stringify(val)); } catch { /* oväsentligt */ }
  }
  function filt(): ListFilter {
    // kompis-filtret är meningslöst utan data (utloggad / inga kompisregler) — ignorera det då
    const regler = marks.size ? val.regler : val.regler.filter((r) => r !== "kompis");
    return { niva: val.niva, regler, pos: val.pos };
  }
  function dropUndo(): void {
    if (undo) window.clearTimeout(undo.timer);
    undo = null;
  }
  /** Nivå för ord ELLER böjning (null = okänt id). */
  function unitLevel(id: string): Level | null {
    const w = store.byId.get(id);
    if (w) return store.wordStatus(w).level;
    const f = store.formById.get(id);
    return f ? store.wordStatus(formAsWord(f)).level : null;
  }
  function unitEs(id: string): string {
    return store.byId.get(id)?.es ?? store.formById.get(id)?.es ?? id;
  }

  el.innerHTML = `
    <div class="lista">
      <div class="searchrow">
        <label class="search">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input id="searchInput" type="search" placeholder="Sök bland ${store.words.length + store.forms.length} ord …" aria-label="Sök ord">
        </label>
        <button type="button" class="icobtn" id="sortBtn" aria-label="Sortera">${IKON_SORT}</button>
        <button type="button" class="icobtn" id="filtBtn" aria-label="Filtrera">${IKON_FILTER}<span class="bdot" hidden></span></button>
      </div>
      <div class="listastatus" id="statusRad" hidden></div>
      <div class="rows" id="rows"></div>
      <div class="sentinel" id="sentinel" aria-hidden="true"></div>
      <p class="slutrad" id="slutRad" hidden></p>
      <div class="dimmer" id="dimmer" hidden></div>
      <div class="blad" id="blad" hidden></div>
    </div>`;

  const rowsEl = el.querySelector<HTMLElement>("#rows")!;
  const searchEl = el.querySelector<HTMLInputElement>("#searchInput")!;
  const sortBtn = el.querySelector<HTMLButtonElement>("#sortBtn")!;
  const filtBtn = el.querySelector<HTMLButtonElement>("#filtBtn")!;
  const statusRad = el.querySelector<HTMLElement>("#statusRad")!;
  const sentinel = el.querySelector<HTMLElement>("#sentinel")!;
  const slutRad = el.querySelector<HTMLElement>("#slutRad")!;
  const dimmer = el.querySelector<HTMLElement>("#dimmer")!;
  const blad = el.querySelector<HTMLElement>("#blad")!;

  function matching(): WordStatus[] {
    const q = query.toLowerCase();
    const out: WordStatus[] = [];
    for (const w of store.words) {
      if (q && !w.es.toLowerCase().includes(q) && !w.sv.toLowerCase().includes(q)) continue;
      out.push(store.wordStatus(w));
    }
    // böjningarna som egna rader, insprängda på sin korpusplats (rank = slot)
    for (const f of store.forms) {
      const sw = formAsWord(f);
      if (q && !sw.es.toLowerCase().includes(q) && !sw.sv.toLowerCase().includes(q)) continue;
      out.push(store.wordStatus(sw));
    }
    out.sort((a, b) => a.word.rank - b.word.rank);
    const filtered = filtreraLista(out, filt(),
      (id) => marks.has(id), (id) => !!store.userWord(id).mnem);
    return sorteraLista(filtered, val.sort);
  }

  /** Exempelmening (Tatoeba) med ev. svensk översättning. */
  function exampleHtml(wordId: string): string {
    const ex = store.exampleFor(wordId);
    if (!ex) return "";
    const overs = ex.sv ?? ex.en; // engelska som reserv när svensk länk saknas
    return `<div><div class="xl">Exempel</div>
      <p class="exline">${esc(ex.es)}</p>
      ${overs ? `<p class="exsv">${esc(overs)}</p>` : ""}</div>`;
  }

  /** Verbets böjningsformer med status-prick (grå = inte introducerad än). */
  function formsHtml(wordId: string): string {
    const forms = store.formsByParent.get(wordId);
    if (!forms?.length) return "";
    const chips = [...forms].sort((a, b) => a.r - b.r).map((f) => {
      const a = store.card(f.id, "es2sv");
      const b = store.card(f.id, "sv2es");
      const cls = a && b && [a, b].every(isKnown) ? "kan" : a || b ? "lar" : "ny";
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

  /** 💡-chippen: vilka kompisar har en regel för ordet. */
  function kompisChip(wordId: string): string {
    const names = marks.get(wordId);
    if (!names?.length) return "";
    const label = names.length > 2
      ? String(names.length)
      : names.map((n) => (n[0] ?? "?").toUpperCase()).join(" ");
    return `<span class="chip-kompis" title="${esc(names.join(", "))}">💡 ${esc(label)}</span>`;
  }

  /** Liten radnotis: datum i nyast-läget, felantal i krångligast-läget. */
  function radNotis(ws: WordStatus): string {
    if (val.sort === "nyast") {
      const at = introAt(ws);
      return at ? `<span class="datemeta">${esc(dagEtikett(at))}</span>` : "";
    }
    if (val.sort === "kranglig") {
      const fel = felAntal(ws);
      return fel > 0 ? `<span class="datemeta">${fel} fel</span>` : "";
    }
    return "";
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

  /** Avstå/ta tillbaka-länken i expansionen — flaggan sitter på enhetens eget id. */
  function avstaHtml(id: string): string {
    return `<button type="button" class="linkbtn avstalank" data-avsta>
      ${store.userWord(id).skip ? "ta tillbaka ordet i övningarna" : "öva inte på det här ordet"}</button>`;
  }

  /** Böjningsradens expansion: stege + härkomst + minnesregel (inga syns/exempel). */
  function formRowx(ws: WordStatus, f: VerbForm, uw: { mnem: string }): string {
    const parent = store.byId.get(f.parent);
    return `
      ${stegeHtml(ws)}
      <div><div class="xl">Verbböjning · presens</div>
        <p class="parentline" style="margin:4px 0 0">av <b>${esc(parent?.es ?? f.parent)}</b> = ${esc(parent?.sv ?? "")}</p></div>
      <div><div class="xl">Minnesregel — din egen</div>
        <textarea data-mnem aria-label="Minnesregel"
          placeholder="Skriv något som får formen att fastna …">${esc(uw.mnem)}</textarea></div>
      <button type="button" class="mini" data-savemnem>Spara</button>
      ${avstaHtml(f.id)}`;
  }

  function rowHtml(ws: WordStatus): string {
    const { word } = ws;
    const uw = store.userWord(word.id);
    const open = word.id === openId;
    const av = store.avstadd(word.id);
    const avChip = av ? `<span class="chip-avsta">övas inte</span>` : "";
    const es = word.art ? `${word.art} ${word.es}` : word.es;
    const form = word.pos === "vform" ? store.formById.get(word.id) : undefined;
    if (form) {
      const known = ws.level === "kan";
      return `
      <div class="row${open ? " open" : ""}${av ? " avstadd" : ""}" data-id="${esc(word.id)}">
        <div class="rowline">
          <button type="button" class="rowbtn" aria-expanded="${open}">
            <span class="es">${esc(word.es)}</span><span class="sv">${esc(word.sv)}</span>
            <span class="meta">
              <span class="rank">#${word.rank}</span>
              ${avChip}
              ${uw.mnem ? `<span class="chip-regel">regel</span>` : ""}
              ${radNotis(ws)}
              ${pathHtml(ws)}
            </span>
          </button>
          <button type="button" class="qmark${known ? " done" : ""}" data-qmark
            aria-pressed="${known}" aria-label="${known ? "Markerad: kan det" : "Markera: kan det"}">✓</button>
        </div>
        ${undo?.id === word.id
          ? `<div class="qstrip">Kan det — kollas om 21 dagar ·
              <button type="button" data-qundo>ångra</button></div>` : ""}
        <div class="rowx">${formRowx(ws, form, uw)}</div>
      </div>`;
    }
    const baseSyns = word.syn.map((s) => `<span class="syn">${esc(s)}</span>`).join("");
    const ownSyns = uw.syn
      .map((s) => `<button class="syn egen" data-delsyn="${esc(s)}" title="Ta bort">${esc(s)} ×</button>`)
      .join("");
    const known = ws.level === "kan";
    return `
      <div class="row${open ? " open" : ""}${av ? " avstadd" : ""}" data-id="${esc(word.id)}">
        <div class="rowline">
          <button type="button" class="rowbtn" aria-expanded="${open}">
            <span class="es">${esc(es)}</span><span class="sv">${esc(word.sv)}</span>
            <span class="meta">
              <span class="rank">#${word.rank}</span>
              ${avChip}
              ${uw.mnem ? `<span class="chip-regel">regel</span>` : ""}
              ${kompisChip(word.id)}
              ${radNotis(ws)}
              ${pathHtml(ws)}
            </span>
          </button>
          <button type="button" class="qmark${known ? " done" : ""}" data-qmark
            aria-pressed="${known}" aria-label="${known ? "Markerad: kan det" : "Markera: kan det"}">✓</button>
        </div>
        ${undo?.id === word.id
          ? `<div class="qstrip">Kan det — kollas om 21 dagar ·
              <button type="button" data-qundo>ångra</button></div>` : ""}
        <div class="rowx">
          ${stegeHtml(ws)}
          <div><div class="xl">${esc(POS_LABEL[word.pos] ?? word.pos)}</div>
            ${word.hint ? `<p class="omtext" style="margin:4px 0 0">Ledtråd: <i>(${esc(word.hint)})</i></p>` : ""}
            ${word.alt?.length ? `<p class="omtext" style="margin:4px 0 0">Accepteras även: ${word.alt.map(esc).join(", ")}</p>` : ""}</div>
          ${exampleHtml(word.id)}
          <div><div class="xl">Synonymer</div>
            <div class="syns">${baseSyns}${ownSyns}
              <input type="text" data-addsyn placeholder="+ lägg till" aria-label="Lägg till synonym"></div></div>
          ${formsHtml(word.id)}
          <div><div class="xl">Minnesregel — din egen</div>
            <textarea data-mnem aria-label="Minnesregel"
              placeholder="Skriv något som får ordet att fastna …">${esc(uw.mnem)}</textarea></div>
          <div class="frules" data-frw="${esc(word.id)}"></div>
          <button type="button" class="mini" data-savemnem>Spara</button>
          ${avstaHtml(word.id)}
        </div>
      </div>`;
  }

  const REGEL_SV: Record<RegelFilter, string> = {
    kompis: "💡 Kompisregler", egen: "Egen regel", saknar: "Saknar regel",
  };
  const POSG_SV: Record<PosGrupp, string> = {
    n: "Substantiv", v: "Verb", adj: "Adjektiv", form: "Böjningar", ovrig: "Övrigt",
  };

  function renderStatus(total: number): void {
    const f = filt();
    const aktiva = antalFilter(f);
    const parts: string[] = [];
    if (val.sort !== "vanligast") parts.push(`<b>${SORT_SV[val.sort]}</b>`);
    for (const n of f.niva) parts.push(`<b>${LEVEL_SV[n]}</b>`);
    for (const r of f.regler) parts.push(`<b>${REGEL_SV[r]}</b>`);
    for (const p of f.pos) parts.push(`<b>${POSG_SV[p]}</b>`);
    statusRad.hidden = parts.length === 0;
    if (parts.length) {
      statusRad.innerHTML = `${parts.join("<span class=\"skilj\">·</span>")}
        <span class="antal">${total} ord</span>
        ${aktiva ? `<button type="button" class="rensa" data-rensa>rensa</button>` : ""}`;
    }
    sortBtn.classList.toggle("set", val.sort !== "vanligast");
    filtBtn.classList.toggle("on", aktiva > 0);
    filtBtn.querySelector<HTMLElement>(".bdot")!.hidden = aktiva === 0;
  }

  function renderRows(): void {
    const list = matching();
    lastTotal = list.length;
    rowsEl.innerHTML = list.slice(0, shown).map(rowHtml).join("");
    renderStatus(list.length);
    const klar = list.length <= shown;
    sentinel.hidden = klar;
    slutRad.hidden = !klar;
    slutRad.textContent = list.length === store.words.length + store.forms.length
      ? `${list.length} ord` : `${list.length} ord matchar`;
    // väck observern så nästa sida laddas direkt om slutet redan syns
    io.unobserve(sentinel);
    if (!klar) io.observe(sentinel);
  }

  // oändlig lista: ladda nästa sida när slut-vakten närmar sig skärmen
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && shown < lastTotal) {
      shown += PAGE;
      renderRows();
    }
  }, { rootMargin: "600px 0px" });

  // ---------- bottenblad ----------
  function sortBladHtml(): string {
    const opt = (key: SortKey, sub: string) => `
      <button type="button" class="sopt${val.sort === key ? " on" : ""}" data-sort="${key}">
        <i></i>${SORT_SV[key]}<small>${sub}</small></button>`;
    return `<div class="grip"></div><div class="bladt">Sortera</div>
      ${opt("vanligast", "frekvens i spanskan")}
      ${opt("nyast", "senast introducerad")}
      ${opt("kranglig", "flest fel")}
      ${opt("alfa", "alfabetiskt")}`;
  }

  function filterBladHtml(): string {
    const tag = (grupp: string, key: string, label: string, on: boolean, varm = false) =>
      `<button type="button" class="tagg${on ? " on" : ""}${varm ? " varm" : ""}"
        data-tag="${grupp}" data-key="${key}">${label}</button>`;
    const nivaTags = LEVELS.map((l) => tag("niva", l, LEVEL_SV[l], val.niva.includes(l))).join("");
    const regelTags = [
      marks.size ? tag("regler", "kompis", REGEL_SV.kompis, val.regler.includes("kompis"), true) : "",
      tag("regler", "egen", REGEL_SV.egen, val.regler.includes("egen")),
      tag("regler", "saknar", REGEL_SV.saknar, val.regler.includes("saknar")),
    ].join("");
    const posTags = (Object.keys(POSG_SV) as PosGrupp[])
      .map((p) => tag("pos", p, POSG_SV[p], val.pos.includes(p))).join("");
    return `<div class="grip"></div>
      <div class="bladt">Nivå</div><div class="taggrp">${nivaTags}</div>
      <div class="bladt">Regler</div><div class="taggrp">${regelTags}</div>
      <div class="bladt">Ordklass</div><div class="taggrp">${posTags}</div>
      <div class="bladbtns">
        <button type="button" class="btn ghost" data-rensa>Rensa</button>
        <button type="button" class="btn" data-stang>Visa ${lastTotal} ord</button>
      </div>`;
  }

  function openSheet(which: "sort" | "filter"): void {
    sheet = which;
    dimmer.hidden = false;
    blad.hidden = false;
    blad.innerHTML = which === "sort" ? sortBladHtml() : filterBladHtml();
  }
  function closeSheet(): void {
    sheet = null;
    dimmer.hidden = true;
    blad.hidden = true;
  }

  sortBtn.addEventListener("click", () => openSheet("sort"));
  filtBtn.addEventListener("click", () => openSheet("filter"));
  dimmer.addEventListener("click", closeSheet);

  blad.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const sopt = t.closest<HTMLElement>("[data-sort]");
    if (sopt) {
      val.sort = sopt.dataset.sort as SortKey;
      saveVal();
      shown = PAGE;
      renderRows();
      closeSheet();
      return;
    }
    const tagg = t.closest<HTMLElement>("[data-tag]");
    if (tagg) {
      const grupp = tagg.dataset.tag as "niva" | "regler" | "pos";
      const key = tagg.dataset.key!;
      const list = val[grupp] as string[];
      const i = list.indexOf(key);
      if (i >= 0) list.splice(i, 1); else list.push(key);
      saveVal();
      shown = PAGE;
      renderRows();
      if (sheet === "filter") blad.innerHTML = filterBladHtml();
      return;
    }
    if (t.closest("[data-rensa]")) {
      val.niva = []; val.regler = []; val.pos = [];
      saveVal();
      shown = PAGE;
      renderRows();
      if (sheet === "filter") blad.innerHTML = filterBladHtml();
      return;
    }
    if (t.closest("[data-stang]")) closeSheet();
  });

  statusRad.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-rensa]")) {
      val.niva = []; val.regler = []; val.pos = [];
      saveVal();
      shown = PAGE;
      renderRows();
    }
  });

  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim();
    shown = PAGE;
    moved = null;
    renderRows();
  });

  rowsEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(".row");
    if (!row) return;
    const id = row.dataset.id!;
    const qm = t.closest<HTMLElement>("[data-qmark]");
    if (qm) {
      const lvl = unitLevel(id);
      if (lvl === null || lvl === "kan") return; // okänt id / redan där
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
      if (lvl === "ny" && !window.confirm(`Nollställa "${unitEs(id)}"? Ordet börjar om från Ny.`)) return;
      store.setLevel(id, lvl);
      moved = { id, text: MOVED_MSG[lvl] };
      renderRows();
      return;
    }
    if (t.closest("[data-avsta]")) {
      // växlar enhetens EGEN flagga — ordet göms/återvänder i övningarna direkt
      store.setAvstadd(id, !store.userWord(id).skip);
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
      // kompisregler finns bara på ord — spara en fråga för böjningsrader
      if (openId === id && !store.formById.has(id)) loadFriendRules(id);
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

  // 💡-markeringarna fylls på i bakgrunden — rita om när de landat
  if (social) {
    void social.ruleMarks().then((m) => {
      if (!m.size || !el.contains(rowsEl)) return;
      marks = m;
      const a = document.activeElement;
      if (a && rowsEl.contains(a) && a.matches("input,textarea")) return;
      renderRows();
      if (sheet === "filter") blad.innerHTML = filterBladHtml();
    });
  }
}
