import { Session, type Pending } from "../lib/session";
import type { Store } from "../lib/store";
import type { CardRec } from "../lib/types";
import { POS_LABEL } from "../lib/types";

type UiState =
  | "idle" | "question" | "good" | "hard" | "override"
  | "wrong" | "forced" | "done";

const AUTO_STATES: UiState[] = ["good", "hard", "override"];
const AUTO_MS: Record<string, number> = { good: 1500, hard: 2600, override: 2600 };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const IC_OK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
const IC_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

export class PassView {
  private session: Session | null = null;
  private state: UiState = "idle";
  private timer: number | null = null;
  private tRemain = 0;
  private tStart = 0;
  private paused = false;

  private card: HTMLElement;
  private input: HTMLInputElement;
  private form: HTMLFormElement;
  private bar: HTMLElement;
  private count: HTMLElement;
  private chip: HTMLElement;

  constructor(
    el: HTMLElement,
    private store: Store,
    private onDone: () => void,
    private onStartRequest: (includeNew: boolean) => void
  ) {
    el.innerHTML = `
      <div class="pass">
        <div>
          <div class="pbar"><i id="passBar"></i></div>
          <div class="pmeta">
            <span class="pcount" id="passCount"></span>
            <span class="dirchip" id="dirChip"></span>
          </div>
        </div>
        <div class="cardwrap"><div class="card st-idle" id="passCard" aria-live="polite"></div></div>
        <form class="answerbar" id="answerForm" autocomplete="off">
          <input id="answerInput" type="text" inputmode="text" enterkeyhint="send"
                 autocapitalize="none" autocorrect="off" spellcheck="false"
                 placeholder="" aria-label="Ditt svar">
          <button class="send" type="submit" aria-label="Rätta svaret">
            <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
          </button>
        </form>
      </div>`;
    this.card = el.querySelector("#passCard")!;
    this.input = el.querySelector("#answerInput")!;
    this.form = el.querySelector("#answerForm")!;
    this.bar = el.querySelector("#passBar")!;
    this.count = el.querySelector("#passCount")!;
    this.chip = el.querySelector("#dirChip")!;

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.onSubmit();
    });
    this.card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) { this.onAction(act); return; }
      if (target.closest("textarea,input,button,a")) return;
      if (AUTO_STATES.includes(this.state)) this.togglePause();
    });
  }

  start(cards: CardRec[]): void {
    this.clearTimer();
    this.session = new Session(this.store, cards);
    if (this.session.finished) {
      this.state = "done";
      this.render();
      return;
    }
    this.state = "question";
    this.render();
    this.focusInput();
  }

  get active(): boolean {
    return this.session !== null && !this.session.finished;
  }

  focusInput(): void {
    if (this.state === "question") this.input.focus({ preventScroll: true });
  }

  // ---------- flöde ----------
  private onSubmit(): void {
    const s = this.session;
    if (!s) return;
    if (AUTO_STATES.includes(this.state)) { this.advance(); return; }
    if (this.state === "wrong") { this.saveMnemIfAny(); this.advance(); return; }
    if (this.state === "forced") {
      const ta = this.card.querySelector<HTMLTextAreaElement>("#mnemInput");
      if (ta && ta.value.trim()) { this.store.setMnem(s.pending!.word.id, ta.value); this.advance(); }
      else ta?.focus();
      return;
    }
    if (this.state !== "question") return;

    const raw = this.input.value;
    if (!raw.trim()) {
      this.input.classList.add("shake");
      window.setTimeout(() => this.input.classList.remove("shake"), 400);
      return;
    }
    const p = s.answer(raw);
    this.input.value = "";
    if (p.grade === "good") { this.state = "good"; this.render(); this.startAuto(AUTO_MS.good); }
    else if (p.grade === "hard") { this.state = "hard"; this.render(); this.startAuto(AUTO_MS.hard); }
    else { this.state = p.forcedMnem ? "forced" : "wrong"; this.render(); }
  }

  private onAction(act: string): void {
    const s = this.session;
    if (!s) return;
    if (act === "next") { this.saveMnemIfAny(); this.advance(); }
    else if (act === "save") {
      const ta = this.card.querySelector<HTMLTextAreaElement>("#mnemInput");
      if (ta && ta.value.trim() && s.pending) {
        this.store.setMnem(s.pending.word.id, ta.value);
        this.advance();
      }
    } else if (act === "override") {
      s.override();
      this.state = "override";
      this.render();
      this.startAuto(AUTO_MS.override);
    } else if (act === "restart") {
      this.onDone();
    } else if (act === "startFull") {
      this.onStartRequest(true);
    } else if (act === "startRep") {
      this.onStartRequest(false);
    }
  }

  private saveMnemIfAny(): void {
    const s = this.session;
    const ta = this.card.querySelector<HTMLTextAreaElement>("#mnemInput");
    if (s?.pending && ta && ta.value.trim() && ta.value.trim() !== this.store.userWord(s.pending.word.id).mnem) {
      this.store.setMnem(s.pending.word.id, ta.value);
    }
  }

  private advance(): void {
    const s = this.session;
    if (!s) return;
    this.clearTimer();
    s.commit();
    if (s.finished) {
      this.state = "done";
      this.store.snapshotToday();
      this.render();
      return;
    }
    this.state = "question";
    this.render();
    this.focusInput();
  }

  // ---------- timer ----------
  private clearTimer(): void {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    this.paused = false;
    this.card.classList.remove("paused");
  }
  private startAuto(ms: number): void {
    this.clearTimer();
    this.tRemain = ms;
    this.tStart = Date.now();
    this.timer = window.setTimeout(() => this.advance(), ms);
    const bar = this.card.querySelector<HTMLElement>("#cdbar");
    if (bar) bar.style.animationDuration = `${ms}ms`;
  }
  private togglePause(): void {
    const note = this.card.querySelector<HTMLElement>("#tapnote");
    if (!this.paused) {
      if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
      this.tRemain -= Date.now() - this.tStart;
      this.paused = true;
      this.card.classList.add("paused");
      if (note) note.textContent = "pausat — tryck för att fortsätta";
    } else {
      this.tStart = Date.now();
      this.timer = window.setTimeout(() => this.advance(), Math.max(this.tRemain, 300));
      this.paused = false;
      this.card.classList.remove("paused");
      if (note) note.textContent = "tryck för paus · Enter för nästa";
    }
  }

  // ---------- rendering ----------
  private displayEs(p: Pending): string {
    return p.word.art ? `${p.word.art} ${p.word.es}` : p.word.es;
  }
  private facit(p: Pending): string {
    return p.card.dir === "es2sv" ? p.word.sv : this.displayEs(p);
  }
  private mnemBox(wordId: string): string {
    const m = this.store.userWord(wordId).mnem;
    if (!m) return "";
    return `<div class="mnembox"><span class="mlabel">Din minnesregel</span><p class="mtext">${esc(m)}</p></div>`;
  }
  private alsoLine(p: Pending): string {
    if (p.card.dir !== "es2sv") return "";
    const uw = this.store.userWord(p.word.id);
    const syns = [...p.word.syn, ...uw.syn];
    if (!syns.length) return "";
    return `<p class="also">även: <b>${syns.slice(0, 6).map(esc).join("</b> · <b>")}</b></p>`;
  }
  private mnemForm(p: Pending, required: boolean): string {
    const pre = esc(this.store.userWord(p.word.id).mnem);
    const lbl = required ? "Minnesregel — obligatorisk nu" : "Minnesregel — frivillig, alltid din egen";
    let h = `<div class="mnemform"><label for="mnemInput">${lbl}</label>
      <textarea id="mnemInput" placeholder="Skriv något som får ordet att fastna …">${pre}</textarea>
      <div class="btnrow">`;
    if (!required) h += `<button type="button" class="btn ghost" data-act="next">Gå vidare</button>`;
    h += `<button type="button" class="btn" data-act="save" id="saveBtn"${pre ? "" : " disabled"}>
        ${pre && required ? "Behåll &amp; gå vidare" : "Spara &amp; gå vidare"}</button></div></div>`;
    return h;
  }

  private template(): string {
    const s = this.session;
    if (this.state === "idle" || !s) {
      const st = this.store.stats();
      const total = st.due + st.newAvailable;
      return `<div class="tomt">
        <div class="stor">Inget pass igång</div>
        <p>${st.due} repetitioner och ${st.newAvailable} nya ord väntar.</p>
        <div class="btnrow" style="max-width:280px">
          <button class="btn" data-act="startFull" ${total === 0 ? "disabled" : ""}>Starta pass</button>
          <button class="btn ghost" data-act="startRep" ${st.due === 0 ? "disabled" : ""}>Bara rep.</button>
        </div></div>`;
    }
    if (this.state === "done") {
      const c = s.counts;
      const answered = c.good + c.hard + c.again;
      return `<p class="verdict v-good">${IC_OK}Passet klart</p>
        <h2 class="head">${c.good + c.hard} av ${answered}</h2>
        <p class="also">rätt <b>${c.good}</b> · med hjälp <b>${c.hard}</b> · fel <b>${c.again}</b></p>
        <div class="btnrow" style="max-width:230px">
          <button type="button" class="btn" data-act="restart">Till startsidan</button></div>`;
    }
    const p = s.pending;
    if (this.state === "question") {
      const card = s.current!;
      const w = s.word(card);
      const prompt = card.dir === "es2sv" ? (w.art ? `${w.art} ${w.es}` : w.es) : w.sv;
      return `<p class="pos">${esc(POS_LABEL[w.pos] ?? w.pos)}</p><h2 class="head">${esc(prompt)}</h2>`;
    }
    if (!p) return "";
    switch (this.state) {
      case "good":
        return `<div class="cd"><i class="cdbar" id="cdbar" style="--cdc:var(--good)"></i></div>
          <p class="verdict v-good">${IC_OK}Rätt</p>
          <h2 class="head">${esc(this.facit(p))}</h2>
          ${this.alsoLine(p)}${this.mnemBox(p.word.id)}
          <p class="tapnote" id="tapnote">tryck för paus · Enter för nästa</p>`;
      case "hard":
        return `<div class="cd"><i class="cdbar" id="cdbar" style="--cdc:var(--warn)"></i></div>
          <p class="verdict v-warn">${IC_OK}Rätt — litet stavfel</p>
          <h2 class="head">${esc(this.facit(p))}</h2>
          <div class="cmp"><span class="cl">du skrev</span><code>${esc(p.raw)}</code>
          <span class="cl">rättstavat</span><code>${esc(p.matched ?? "")}</code></div>
          ${this.mnemBox(p.word.id)}
          <p class="fine">Räknas som tuffare repetition — kortet kommer tillbaka lite tidigare.</p>
          <p class="tapnote" id="tapnote">tryck för paus · Enter för nästa</p>`;
      case "override":
        return `<div class="cd"><i class="cdbar" id="cdbar" style="--cdc:var(--warn)"></i></div>
          <p class="verdict v-warn">${IC_OK}Ändrat: rätt</p>
          <h2 class="head">${esc(this.facit(p))}</h2>
          <p class="also">»<b>${esc(p.raw)}</b>« sparas som synonym — nästa gång rättas den direkt.</p>
          <p class="tapnote" id="tapnote">tryck för paus · Enter för nästa</p>`;
      case "wrong":
        return `<p class="verdict v-bad">${IC_X}Fel</p>
          <div class="cmp"><span class="cl">du skrev</span><code class="wrote">${esc(p.raw)}</code>
          <span class="cl">rätt svar</span><code>${esc(this.facit(p))}</code></div>
          ${this.alsoLine(p)}
          ${this.mnemForm(p, false)}
          <button type="button" class="linkbtn" data-act="override">Jag hade rätt — spara mitt svar som synonym</button>`;
      case "forced":
        return `<p class="verdict v-bad">${IC_X}Fel — andra missen</p>
          <div class="cmp"><span class="cl">du skrev</span><code class="wrote">${esc(p.raw)}</code>
          <span class="cl">rätt svar</span><code>${esc(this.facit(p))}</code></div>
          <div class="block">Nu krävs en egen minnesregel för att gå vidare — det är så orden fastnar.</div>
          ${this.mnemForm(p, true)}
          <button type="button" class="linkbtn" data-act="override">Jag hade rätt — spara mitt svar som synonym</button>`;
    }
    return "";
  }

  render(): void {
    const s = this.session;
    this.card.className = `card st-${this.state}`;
    this.card.innerHTML = this.template();
    if (s && this.state !== "idle") {
      const pr = s.progress();
      this.bar.style.width = pr.total ? `${(pr.done / pr.total) * 100}%` : "100%";
      this.count.textContent = this.state === "done" ? "klart" : `${s.queue.length} kort kvar`;
      const cur = s.pending?.card ?? s.current;
      if (cur) {
        this.chip.textContent = cur.dir === "es2sv" ? "spanska → svenska" : "svenska → spanska";
        this.input.placeholder =
          this.state === "question"
            ? cur.dir === "es2sv" ? "Skriv på svenska …" : "Skriv på spanska …"
            : this.state === "wrong" ? "Enter — gå vidare" : "Enter — nästa";
      }
    } else {
      this.bar.style.width = "0%";
      this.count.textContent = "";
      this.chip.textContent = "";
      this.input.placeholder = "";
    }
    const ta = this.card.querySelector<HTMLTextAreaElement>("#mnemInput");
    if (ta) {
      ta.addEventListener("input", () => {
        const b = this.card.querySelector<HTMLButtonElement>("#saveBtn");
        if (b) b.disabled = !ta.value.trim();
      });
      if (this.state === "forced") ta.focus();
    }
  }
}
