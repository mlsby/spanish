import { diffTarget } from "../lib/diff";
import { clearPass, loadPass, savePass } from "../lib/passpaus";
import { resaFor } from "../lib/resa";
import { Session, type Pending, type SessionState } from "../lib/session";
import type { Social, FriendRule } from "../lib/social";
import type { Store } from "../lib/store";
import type { CardRec } from "../lib/types";
import { PERSON_SV, POS_LABEL } from "../lib/types";

type UiState =
  | "idle" | "question" | "good" | "hard" | "override"
  | "wrong" | "forced" | "done";

const AUTO_STATES: UiState[] = ["good", "hard", "override"];
// stavfel/override visas längre — tiden ska räcka till att SE vad som blev fel
const AUTO_MS: Record<string, number> = { good: 1500, hard: 4000, override: 4000 };

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
  private gaveUp = false;            // "vet inte" — fel-flödet utan "du skrev"-rad
  private showMnem = false;          // ✎-utfällt minnesregelfält i fel-läget
  private friendRules: FriendRule[] = [];
  private kanBefore = 0;         // resapoäng vid passtart — för nivåfirandet
  private pendingSno: string | null = null; // regelägare som får poäng om snodd regel sparas

  private card: HTMLElement;
  private input: HTMLInputElement;
  private form: HTMLFormElement;
  private bar: HTMLElement;
  private count: HTMLElement;
  private chip: HTMLElement;

  constructor(
    private el: HTMLElement,
    private store: Store,
    private onDone: () => void,
    private onStartRequest: (repOnly?: boolean) => void,
    private loggedIn: () => boolean = () => true,
    private syncBusy: () => boolean = () => false,
    private social?: Social
  ) {
    el.innerHTML = `
      <div class="pass">
        <div>
          <div class="pbar"><i id="passBar"></i></div>
          <div class="pmeta">
            <button type="button" class="passexit" id="passExit" hidden aria-label="Avsluta passet">
              <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Avsluta
            </button>
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
        <p class="vetinte" id="vetInte" hidden>
          <button type="button" data-act="giveup">vet inte</button>
        </p>
      </div>`;
    this.card = el.querySelector("#passCard")!;
    this.input = el.querySelector("#answerInput")!;
    this.form = el.querySelector("#answerForm")!;
    this.bar = el.querySelector("#passBar")!;
    this.count = el.querySelector("#passCount")!;
    this.chip = el.querySelector("#dirChip")!;
    el.querySelector<HTMLButtonElement>("#passExit")!.addEventListener("click", () => this.onDone());

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.onSubmit();
    });
    // knappar får aldrig sno fokus från textfältet — annars fälls mobiltangentbordet ihop
    const keepFocus = (e: Event) => {
      if ((e.target as HTMLElement).closest("button")) e.preventDefault();
    };
    this.form.addEventListener("pointerdown", keepFocus);
    const vetInte = el.querySelector<HTMLElement>("#vetInte")!;
    vetInte.addEventListener("pointerdown", keepFocus);
    vetInte.querySelector("button")!.addEventListener("click", () => this.onAction("giveup"));

    // håll in kortet = paus (baren fryser), släpp = fortsätt
    this.card.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button")) { e.preventDefault(); return; }
      if (t.closest("textarea,input,a")) return;
      if (AUTO_STATES.includes(this.state)) {
        e.preventDefault(); // tangentbordet ska inte fällas ihop
        this.holdPause(true);
      }
    });
    const release = () => this.holdPause(false);
    this.card.addEventListener("pointerup", release);
    this.card.addEventListener("pointercancel", release);
    this.card.addEventListener("pointerleave", release);
    this.card.addEventListener("contextmenu", (e) => {
      // iOS långtryck ska pausa, inte öppna delningsmenyn
      if (AUTO_STATES.includes(this.state)) e.preventDefault();
    });
    this.card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const sno = target.closest<HTMLElement>("[data-snoidx]");
      if (sno) {
        const rule = this.friendRules[Number(sno.dataset.snoidx)];
        const ta = this.card.querySelector<HTMLTextAreaElement>("#mnemInput");
        if (rule && ta) {
          ta.value = rule.mnem;
          this.pendingSno = rule.ownerId;
          const b = this.card.querySelector<HTMLButtonElement>("#saveBtn");
          if (b) b.disabled = false;
          ta.focus();
        }
        return;
      }
      const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) { this.onAction(act); return; }
    });
  }

  start(cards: CardRec[], dueSoonBaseline?: number): void {
    this.clearTimer();
    this.kanBefore = this.store.stats().score;
    this.session = new Session(this.store, cards, { dueSoonBaseline });
    if (this.session.finished) {
      this.state = "done";
      this.render();
      return;
    }
    savePass(this.session.snapshot());
    this.state = "question";
    this.render();
    this.focusInput();
  }

  /** Fortsätt en avbruten övning. false = inget kvar att fortsätta (rensat). */
  resume(state: SessionState): boolean {
    this.clearTimer();
    this.kanBefore = this.store.stats().score;
    const s = Session.restore(this.store, state);
    if (s.finished) {
      clearPass();
      return false;
    }
    this.session = s;
    savePass(s.snapshot());
    this.state = "question";
    this.render();
    this.focusInput();
    return true;
  }

  get active(): boolean {
    return this.session !== null && !this.session.finished;
  }

  /** Rita om vilo-/klart-skärmen (färska siffror & inloggningsläge) — rör aldrig ett pågående pass. */
  refreshIdle(): void {
    if (this.state === "idle" || this.state === "done") this.render();
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
    this.gaveUp = false;
    this.showMnem = false;
    this.friendRules = [];
    this.pendingSno = null;
    if (p.grade === "good") { this.state = "good"; this.render(); this.startAuto(AUTO_MS.good); }
    else if (p.grade === "hard") { this.state = "hard"; this.render(); this.startAuto(AUTO_MS.hard); }
    else {
      this.state = p.forcedMnem ? "forced" : "wrong";
      this.render();
      if (this.state === "forced") void this.loadFriendRules(p.word.id);
    }
  }

  /** Kompisarnas regler hämtas i bakgrunden och injiceras — utan att röra det du skriver. */
  private async loadFriendRules(wordId: string): Promise<void> {
    if (!this.social) return;
    const rules = await this.social.friendRules(wordId);
    if (this.state !== "forced" || this.session?.pending?.word.id !== wordId || !rules.length) return;
    this.friendRules = rules;
    const wrap = this.card.querySelector<HTMLElement>("#frwrap");
    if (wrap) wrap.innerHTML = this.friendRulesHtml();
  }

  private friendRulesHtml(): string {
    if (!this.friendRules.length) return "";
    const rows = this.friendRules.map((r, i) =>
      `<div class="frq"><span class="who">${esc(r.name)}</span>
        <span class="q">"${esc(r.mnem)}"</span>
        <button type="button" class="snochip" data-snoidx="${i}">sno</button></div>`
    ).join("");
    return `<div class="frt">Sno från kompisarna</div>${rows}`;
  }

  private onAction(act: string): void {
    // start-/navigeringsknappar funkar utan aktiv session (vilo- och klart-lägena)
    if (act === "start" || act === "gologin") { this.onStartRequest(); return; }
    if (act === "rep") { this.onStartRequest(true); return; }
    if (act === "restart") { this.onDone(); return; }
    const s = this.session;
    if (!s) return;
    if (act === "giveup") {
      // "vet inte" = ge upp utan att hitta på ett svar — samma fel-flöde, ärligare rubrik
      if (this.state !== "question") return;
      const p = s.answer("");
      this.input.value = "";
      this.gaveUp = true;
      this.showMnem = false;
      this.friendRules = [];
      this.pendingSno = null;
      this.state = p.forcedMnem ? "forced" : "wrong";
      this.render();
      if (this.state === "forced") void this.loadFriendRules(p.word.id);
      return;
    }
    if (act === "claim") {
      // "kan redan — bara stavfel": uppgradera till Easy och gå vidare direkt
      if (s.pending?.firstExposure && s.pending.grade === "hard") {
        s.claimKnown();
        this.advance();
      }
      return;
    }
    if (act === "togglemnem") {
      this.showMnem = true;
      this.render();
      this.card.querySelector<HTMLTextAreaElement>("#mnemInput")?.focus();
      return;
    }
    if (act === "next") { this.saveMnemIfAny(); this.advance(); }
    else if (act === "save") {
      const ta = this.card.querySelector<HTMLTextAreaElement>("#mnemInput");
      if (ta && ta.value.trim() && s.pending) {
        this.store.setMnem(s.pending.word.id, ta.value);
        if (this.pendingSno && this.social) {
          void this.social.recordAdoption(this.pendingSno, s.pending.word.id);
        }
        this.advance();
      }
    } else if (act === "override") {
      s.override();
      this.state = "override";
      this.render();
      this.startAuto(AUTO_MS.override);
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
    this.gaveUp = false;
    this.showMnem = false;
    this.pendingSno = null;
    this.friendRules = [];
    s.commit();
    if (s.finished) {
      clearPass(); // övningen slutförd — inget att återuppta
      this.state = "done";
      this.store.snapshotToday();
      this.render();
      return;
    }
    savePass(s.snapshot()); // avbrott härifrån kan alltid fortsättas
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
  private holdPause(on: boolean): void {
    if (!AUTO_STATES.includes(this.state)) return;
    const note = this.card.querySelector<HTMLElement>("#tapnote");
    if (on && !this.paused) {
      if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
      this.tRemain -= Date.now() - this.tStart;
      this.paused = true;
      this.card.classList.add("paused");
      if (note) note.textContent = "pausat — släpp för att gå vidare";
    } else if (!on && this.paused) {
      this.tStart = Date.now();
      this.timer = window.setTimeout(() => this.advance(), Math.max(this.tRemain, 300));
      this.paused = false;
      this.card.classList.remove("paused");
      if (note) note.textContent = "håll för paus · Enter för nästa";
    }
  }

  // ---------- rendering ----------
  private displayEs(p: Pending): string {
    return p.word.art ? `${p.word.art} ${p.word.es}` : p.word.es;
  }
  private facit(p: Pending): string {
    if (p.form) {
      return p.card.dir === "es2sv"
        ? `${PERSON_SV[p.form.person]} ${p.form.svPres}`
        : p.form.es;
    }
    return p.card.dir === "es2sv" ? p.word.sv : this.displayEs(p);
  }
  /** Frågesidan i fel-lägena — man ska se hela paret, inte bara svaret. */
  private promptLine(p: Pending): string {
    const q = p.form
      ? p.card.dir === "es2sv" ? p.form.es : `${PERSON_SV[p.form.person]} ${p.form.svPres}`
      : p.card.dir === "es2sv" ? this.displayEs(p) : p.word.sv;
    return `<p class="qline">${esc(q)} =</p>`;
  }

  /** Stödraden på böjningskort: alltid moderverbet i facit (kravet från Lucas). */
  private parentLine(p: Pending): string {
    if (!p.form) return "";
    return `<p class="parentline">av <b>${esc(p.word.es)}</b> = ${esc(p.word.sv)}</p>`;
  }
  /**
   * Exempelmening (Tatoeba) — bara i facit-lägena, aldrig i frågan (fri
   * återkallning kräver att ordet är enda ledtråden). Svensk översättning
   * visas enbart när man hade fel — där behövs mest hjälp och ingen timer.
   */
  private exLine(p: Pending, withSv: boolean): string {
    const ex = this.store.exampleFor(p.card.wordId);
    if (!ex) return "";
    let h = `<p class="exline">${esc(ex.es)}</p>`;
    if (withSv && ex.sv) h += `<p class="exsv">${esc(ex.sv)}</p>`;
    return h;
  }
  private mnemBox(wordId: string): string {
    const m = this.store.userWord(wordId).mnem;
    if (!m) return "";
    return `<div class="mnembox"><span class="mlabel">Din minnesregel</span><p class="mtext">${esc(m)}</p></div>`;
  }
  /** Facit med de tecken som skiljer sig från svaret markerade. */
  private markedTarget(p: Pending): string {
    const target = p.matched ?? this.facit(p);
    return diffTarget(p.raw, target)
      .map((m) => (m.diff ? `<u>${esc(m.ch)}</u>` : esc(m.ch)))
      .join("");
  }
  private alsoLine(p: Pending): string {
    if (p.form) return ""; // formkort: stödraden med moderverbet räcker
    if (p.card.dir === "es2sv") {
      const uw = this.store.userWord(p.word.id);
      const syns = [...p.word.syn, ...uw.syn];
      if (!syns.length) return "";
      return `<p class="also">även: <b>${syns.slice(0, 6).map(esc).join("</b> · <b>")}</b></p>`;
    }
    const alts = p.word.alt ?? [];
    if (!alts.length) return "";
    return `<p class="also">även rätt: <b>${alts.map(esc).join("</b> · <b>")}</b></p>`;
  }
  private hintLine(w: { hint?: string }): string {
    return w.hint ? `<p class="hintled">(${esc(w.hint)})</p>` : "";
  }
  private mnemForm(p: Pending, required: boolean): string {
    const pre = esc(this.store.userWord(p.word.id).mnem);
    let h = `<div class="mnemform">
      <textarea id="mnemInput" aria-label="Minnesregel — alltid din egen"
        placeholder="Skriv något som får ordet att fastna …">${pre}</textarea>`;
    if (required) h += `<div class="frules" id="frwrap">${this.friendRulesHtml()}</div>`;
    h += `<div class="btnrow">`;
    if (!required) h += `<button type="button" class="btn ghost" data-act="next">Gå vidare</button>`;
    h += `<button type="button" class="btn" data-act="save" id="saveBtn"${pre ? "" : " disabled"}>
        ${pre && required ? "Behåll &amp; gå vidare" : "Spara &amp; gå vidare"}</button></div></div>`;
    return h;
  }

  private template(): string {
    const s = this.session;
    if (this.state === "idle" || !s) {
      if (!this.loggedIn()) {
        return `<div class="tomt">
          <div class="stor">Logga in först</div>
          <p>Så att ingenting du övar går förlorat — allt sparas i molnet.</p>
          <div class="btnrow" style="max-width:230px">
            <button class="btn" data-act="gologin">Till inloggningen</button>
          </div></div>`;
      }
      const st = this.store.stats();
      const paused = loadPass();
      const total = st.due + st.nextNew;
      const busy = this.syncBusy();
      const label = busy ? "Synkar …"
        : paused ? "Fortsätt övningen"
        : st.firstToday ? "Starta dagens övning" : "Öva mer";
      return `<div class="tomt">
        <div class="stor">${paused ? "Övning pausad" : "Ingen övning igång"}</div>
        ${paused ? `<p>Du fortsätter där du slutade.</p>` : ""}
        <div class="btnrow" style="max-width:250px">
          <button class="btn" data-act="start" ${(!paused && total === 0) || busy ? "disabled" : ""}>${label}</button>
          <button class="btn ghost" data-act="rep" ${busy || !st.repAvailable ? "disabled" : ""}>Repetera</button>
        </div></div>`;
    }
    if (this.state === "done") {
      const c = s.counts;
      const answered = c.good + c.hard + c.again;
      const st = this.store.stats();
      const more = st.due + st.nextNew > 0;
      const forecast = s.forecastAdded();
      const r = resaFor(st.score);
      const uppflytt = resaFor(this.kanBefore).nr < r.nr;
      return `${uppflytt ? `<p class="nivupp">🏅 ¡Felicidades! Ny nivå: <b>${r.titel.name}</b> — ${r.titel.sub}</p>` : ""}
        <p class="verdict v-good">${IC_OK}Övningen klar</p>
        <h2 class="head">${c.good + c.hard} av ${answered}</h2>
        <p class="also">rätt <b>${c.good}</b> · med hjälp <b>${c.hard}</b> · fel <b>${c.again}</b></p>
        ${forecast > 0 ? `<p class="fine">~${forecast} repetitioner läggs på kommande vecka.</p>` : ""}
        <div class="btnrow" style="max-width:250px">
          ${more ? `<button type="button" class="btn" data-act="start">Öva mer</button>
          <button type="button" class="btn ghost" data-act="restart">Till startsidan</button>`
          : `<button type="button" class="btn" data-act="restart">Till startsidan</button>`}
        </div>`;
    }
    const p = s.pending;
    if (this.state === "question") {
      const card = s.current!;
      const w = s.word(card);
      const form = this.store.formFor(card);
      const prompt = form
        ? card.dir === "es2sv" ? form.es : `${PERSON_SV[form.person]} ${form.svPres}`
        : card.dir === "es2sv" ? (w.art ? `${w.art} ${w.es}` : w.es) : w.sv;
      const posLabel = form ? "verb · presens" : (POS_LABEL[w.pos] ?? w.pos);
      // ledtråden särskiljer svenska dubbletter — visas bara åt sv→es-hållet
      const hint = card.dir === "sv2es" ? this.hintLine(w) : "";
      return `<p class="pos">${esc(posLabel)}</p><h2 class="head">${esc(prompt)}</h2>${hint}`;
    }
    if (!p) return "";
    switch (this.state) {
      case "good":
        return `<div class="cd"><i class="cdbar" id="cdbar" style="--cdc:var(--good)"></i></div>
          <p class="verdict v-good">${IC_OK}Rätt</p>
          <h2 class="head">${esc(this.facit(p))}</h2>
          ${this.parentLine(p)}${this.hintLine(p.word)}${this.exLine(p, false)}${this.alsoLine(p)}${this.mnemBox(p.word.id)}
          <p class="tapnote" id="tapnote">håll för paus · Enter för nästa</p>`;
      case "hard":
        return `<div class="cd"><i class="cdbar" id="cdbar" style="--cdc:var(--warn)"></i></div>
          <p class="verdict v-warn">${IC_OK}Rätt — litet stavfel</p>
          <h2 class="head">${esc(this.facit(p))}</h2>
          ${this.parentLine(p)}${this.hintLine(p.word)}${this.exLine(p, false)}
          <div class="cmp"><span class="cl">du skrev</span><code>${esc(p.raw)}</code>
          <span class="cl">rättstavat</span><code>${this.markedTarget(p)}</code></div>
          ${this.mnemBox(p.word.id)}
          ${p.firstExposure
            ? `<button type="button" class="linkbtn" data-act="claim">kan redan — bara stavfel</button>`
            : `<p class="fine">Räknas som tuffare repetition — kortet kommer tillbaka lite tidigare.</p>`}
          <p class="tapnote" id="tapnote">håll för paus · Enter för nästa</p>`;
      case "override":
        return `<div class="cd"><i class="cdbar" id="cdbar" style="--cdc:var(--warn)"></i></div>
          <p class="verdict v-warn">${IC_OK}Ändrat: rätt</p>
          ${this.promptLine(p)}
          <h2 class="head">${esc(this.facit(p))}</h2>
          ${this.parentLine(p)}
          <p class="also">»<b>${esc(p.raw)}</b>« sparas som synonym — nästa gång rättas den direkt.</p>
          <p class="tapnote" id="tapnote">håll för paus · Enter för nästa</p>`;
      case "wrong":
        return `<p class="verdict v-bad">${IC_X}${this.gaveUp ? "Visste inte" : "Fel"}</p>
          ${this.gaveUp ? "" : `<p class="wrote">du skrev <s>${esc(p.raw)}</s>
            <button type="button" class="linkbtn" data-act="override">jag hade rätt</button></p>`}
          ${this.promptLine(p)}
          <h2 class="head">${esc(this.facit(p))}</h2>
          ${this.parentLine(p)}${this.hintLine(p.word)}${this.exLine(p, true)}${this.alsoLine(p)}
          ${this.showMnem
            ? this.mnemForm(p, false)
            : `<div class="btnrow" style="margin-top:8px">
                <button type="button" class="btn ghost" data-act="togglemnem">✎ Minnesregel</button>
                <button type="button" class="btn" data-act="next">Gå vidare</button></div>`}`;
      case "forced":
        return `<p class="verdict v-bad">${IC_X}${this.gaveUp ? "Visste inte" : "Fel"} — andra missen</p>
          ${this.gaveUp ? "" : `<p class="wrote">du skrev <s>${esc(p.raw)}</s>
            <button type="button" class="linkbtn" data-act="override">jag hade rätt</button></p>`}
          ${this.promptLine(p)}
          <h2 class="head">${esc(this.facit(p))}</h2>
          ${this.parentLine(p)}${this.hintLine(p.word)}${this.exLine(p, true)}${this.alsoLine(p)}
          <p class="mustnote">Skriv din egen minnesregel för att gå vidare</p>
          ${this.mnemForm(p, true)}`;
    }
    return "";
  }

  /** Pågår ett pass just nu? Styr avsluta-knappen och att flikraden göms. */
  private get live(): boolean {
    return this.session !== null && this.state !== "idle" && this.state !== "done";
  }

  render(): void {
    const s = this.session;
    this.card.className = `card st-${this.state}`;
    this.card.innerHTML = this.template();
    this.el.querySelector<HTMLButtonElement>("#passExit")!.hidden = !this.live;
    this.el.querySelector<HTMLElement>("#vetInte")!.hidden = this.state !== "question";
    document.getElementById("app")?.classList.toggle("pass-live", this.live);
    if (s && this.state !== "idle") {
      const pr = s.progress();
      this.bar.style.width = pr.total ? `${(pr.done / pr.total) * 100}%` : "100%";
      this.count.textContent = this.state === "done"
        ? "klart"
        : `${s.queue.length} kort kvar`;
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
