import type { Store, WordStatus } from "../lib/store";
import { stabilityDays } from "../lib/scheduler";
import { POS_LABEL } from "../lib/types";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PAGE = 100;

export function renderOrdlista(el: HTMLElement, store: Store): void {
  let query = "";
  let shown = PAGE;
  let openId: string | null = null;

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

  function rowHtml(ws: WordStatus): string {
    const { word, status, cards } = ws;
    const uw = store.userWord(word.id);
    const open = word.id === openId;
    const stab = cards.length ? `${Math.min(...cards.map(stabilityDays))} d` : "—";
    const es = word.art ? `${word.art} ${word.es}` : word.es;
    const baseSyns = word.syn.map((s) => `<span class="syn">${esc(s)}</span>`).join("");
    const ownSyns = uw.syn
      .map((s) => `<button class="syn egen" data-delsyn="${esc(s)}" title="Ta bort">${esc(s)} ×</button>`)
      .join("");
    return `
      <div class="row${open ? " open" : ""}" data-id="${esc(word.id)}">
        <button type="button" class="rowbtn" aria-expanded="${open}">
          <span class="es">${esc(es)}</span><span class="sv">${esc(word.sv)}</span>
          <span class="meta">
            ${uw.mnem ? `<span class="chip-regel">regel</span>` : ""}
            <span class="stab">${stab}</span>
            <span class="dot ${status === "kan" ? "kan" : status === "lar" ? "lar" : "ny"}"></span>
          </span>
        </button>
        <div class="rowx">
          <div><div class="xl">${esc(POS_LABEL[word.pos] ?? word.pos)} · rank ${word.rank}</div></div>
          <div><div class="xl">Synonymer</div>
            <div class="syns">${baseSyns}${ownSyns}
              <input type="text" data-addsyn placeholder="+ lägg till" aria-label="Lägg till synonym"></div></div>
          <div><div class="xl">Minnesregel — din egen</div>
            <textarea data-mnem aria-label="Minnesregel"
              placeholder="Skriv något som får ordet att fastna …">${esc(uw.mnem)}</textarea></div>
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
      renderRows();
    }
  });
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
