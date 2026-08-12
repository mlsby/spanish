import { diffTarget } from "../lib/diff";
import { gradeAnswer, type GradeResult } from "../lib/grading";
import {
  byggQuiz, byggUnderlag, hamtaText, kandidatYtor, type LasKandidat, lasCommit,
  type LasFraga, lasNiva, minnsQuizzade,
} from "../lib/lastext";
import type { Store } from "../lib/store";
import type { SupabaseClient } from "../lib/supabase";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const IC_OK = `<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>`;
const IC_X = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

type LasState = "laddar" | "fel" | "las" | "fraga" | "svar" | "klar";

const SENASTE_KEY = "glosa.las.senaste.v1";

function laddaSenaste(): string[] {
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(SENASTE_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/**
 * Läsförståelsen: en genererad minitext av användarens egna ord →
 * ordfrågor med meningen som kontext (ordet markerat) → texten igen.
 * Ordsvaren bokförs som riktiga FSRS-repetitioner via lasCommit.
 *
 * Skärmen byggs som passet: skelettet (bar, meta, kort, svarsfält)
 * skapas EN gång och bara kortets innehåll byts — inputfältet lever
 * genom hela övningen så mobiltangentbordet aldrig fälls ihop, och
 * Enter går vidare från facit precis som i passet.
 */
export class LasView {
  private state: LasState = "laddar";
  private meningar: string[] = [];
  private quiz: LasFraga[] = [];
  private idx = 0;
  private ratt = 0;
  private pend: (GradeResult & { raw: string }) | null = null;
  private felText = "";
  /** nyligen quizzade ord (nyaste först) — bannlysta ur nästa texter, överlever omladdning */
  private senaste = laddaSenaste();

  private card!: HTMLElement;
  private bar!: HTMLElement;
  private count!: HTMLElement;
  private chip!: HTMLElement;
  private form!: HTMLFormElement;
  private input!: HTMLInputElement;
  private vetinte!: HTMLElement;
  private knappar!: HTMLElement;

  constructor(
    el: HTMLElement,
    private store: Store,
    private sb: SupabaseClient,
    private onExit: () => void,
  ) {
    el.innerHTML = `
      <div class="pass">
        <div>
          <div class="pbar"><i id="lasBar"></i></div>
          <div class="pmeta">
            <button type="button" class="passexit" id="lasExit">
              <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Avsluta
            </button>
            <span class="pcount" id="lasCount"></span>
            <span class="dirchip" id="lasChip">läsning</span>
          </div>
        </div>
        <div class="cardwrap"><div class="card st-idle lascard" id="lasCard" aria-live="polite"></div></div>
        <div class="btnrow lasknappar" id="lasKnappar" hidden></div>
        <form class="answerbar" id="lasForm" autocomplete="off" hidden>
          <input id="lasInput" type="text" inputmode="text" enterkeyhint="send"
                 autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Ditt svar">
          <button class="send" type="submit" aria-label="Rätta svaret">
            <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
          </button>
        </form>
        <p class="vetinte" id="lasVetinte" hidden><button type="button" data-act="giveup">vet inte</button></p>
      </div>`;
    this.card = el.querySelector("#lasCard")!;
    this.bar = el.querySelector("#lasBar")!;
    this.count = el.querySelector("#lasCount")!;
    this.chip = el.querySelector("#lasChip")!;
    this.form = el.querySelector("#lasForm")!;
    this.input = el.querySelector("#lasInput")!;
    this.vetinte = el.querySelector("#lasVetinte")!;
    this.knappar = el.querySelector("#lasKnappar")!;

    el.querySelector("#lasExit")!.addEventListener("click", () => {
      this.setLive(false);
      this.onExit();
    });
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.state === "fraga") this.svara(this.input.value);
      else if (this.state === "svar") this.nasta(); // Enter för nästa — som i passet
    });
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "retry") void this.start();
      if (act === "ord") { this.state = "fraga"; this.render(); this.input.focus(); }
      if (act === "giveup") this.svara("");
    });
    // knappar får aldrig sno fokus från textfältet — annars fälls mobiltangentbordet ihop
    el.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button") && !t.closest("#lasExit")) e.preventDefault();
    });
  }

  /** Hämta en ny text och börja om flödet. */
  async start(): Promise<void> {
    this.setLive(true); // tabbaren gömd från första stund till Avsluta — inget flimmer
    this.state = "laddar";
    this.meningar = [];
    this.quiz = [];
    this.idx = 0;
    this.ratt = 0;
    this.pend = null;
    this.render();
    const p = lasNiva(this.store.stats().score);
    // 3× målet: gott om kandidater att välja bland ger naturligare scener (Lucas)
    const underlag = byggUnderlag(this.store, p.anvand * 3, { exkludera: new Set(this.senaste) });
    if (underlag.kandidater.length === 0) {
      this.felText = "Inga övningsord just nu — öva lite först, sen finns det något att läsa om.";
      this.state = "fel";
      this.render();
      return;
    }
    try {
      const ytor = (k: LasKandidat) => kandidatYtor(this.store, k);
      const meningar = await hamtaText(this.sb, underlag, {
        meningar: p.meningar,
        anvand: Math.min(p.anvand, underlag.kandidater.length),
      }, ytor);
      this.meningar = meningar.map((m) => m.es);
      this.quiz = byggQuiz(meningar, underlag.kandidater, ytor);
      if (!this.quiz.length) throw new Error("Texten saknade övningsord — prova igen.");
      // minns ~3 rundors quizord — de utesluts helt ur kommande texter
      this.senaste = minnsQuizzade(this.senaste, this.quiz.map((q) => q.kandidat.id), p.anvand * 3);
      try { localStorage.setItem(SENASTE_KEY, JSON.stringify(this.senaste)); } catch { /* privat läge */ }
      this.state = "las";
    } catch (e) {
      this.felText = e instanceof Error ? e.message : String(e);
      this.state = "fel";
    }
    this.render();
  }

  /** Samma tabbargömning som passet — hålls under HELA läsflödet. */
  private setLive(on: boolean): void {
    document.getElementById("app")?.classList.toggle("pass-live", on);
  }

  /** Rätta svaret mot samma toleranta regler som passet — och bokför direkt. */
  private svara(raw: string): void {
    if (this.state !== "fraga") return;
    const f = this.quiz[this.idx];
    const card = this.store.card(f.kandidat.id, "es2sv");
    if (!card) { this.nasta(); return; }
    const r = gradeAnswer(raw, this.store.targetsFor(card), "sv");
    const grade = raw.trim() ? r.grade : "again";
    this.pend = { ...r, grade, raw: raw.trim() };
    if (grade !== "again") this.ratt++;
    lasCommit(this.store, f.kandidat.id, grade, raw.trim(), raw.trim() ? r.step : "none");
    this.state = "svar";
    this.render(); // inputfältet lever kvar — tangentbordet ligger stilla
  }

  private nasta(): void {
    this.pend = null;
    this.input.value = "";
    if (this.idx + 1 < this.quiz.length) {
      this.idx++;
      this.state = "fraga";
      this.render();
      this.input.focus(); // redan fokuserat i normalfallet — no-op, inget hopp
    } else {
      this.store.snapshotToday();
      this.state = "klar";
      this.input.blur(); // svarsfältet göms — fäll ihop tangentbordet så hela texten syns
      this.render();
    }
  }

  /** Meningen med övningsordet markerat. */
  private markerad(mening: string, es: string): string {
    const safe = es.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = mening.match(new RegExp(`(^|[^a-záéíóúñüA-ZÁÉÍÓÚÑÜ])(${safe})(?=[^a-záéíóúñüA-ZÁÉÍÓÚÑÜ]|$)`, "i"));
    if (!m || m.index === undefined) return esc(mening);
    const start = m.index + m[1].length;
    return `${esc(mening.slice(0, start))}<mark>${esc(mening.slice(start, start + es.length))}</mark>${esc(mening.slice(start + es.length))}`;
  }

  private textHtml(): string {
    return `<p class="lastext">${this.meningar.map(esc).join(" ")}</p>`;
  }

  private facit(f: LasFraga): string {
    const form = this.store.formById.get(f.kandidat.id);
    if (form) return form.svPres;
    return this.store.byId.get(f.kandidat.id)?.sv ?? f.kandidat.sv;
  }

  /** Facit med de tecken som skiljer sig från svaret markerade — som i passet. */
  private markedFacit(raw: string, f: LasFraga): string {
    const target = this.pend?.matched ?? this.facit(f);
    return diffTarget(raw, target)
      .map((m) => (m.diff ? `<u>${esc(m.ch)}</u>` : esc(m.ch)))
      .join("");
  }

  /** Stödrader som i passet: moderverb för former, annars synonymer. */
  private stodLinjer(f: LasFraga): string {
    const form = this.store.formById.get(f.kandidat.id);
    if (form) {
      const parent = this.store.byId.get(form.parent);
      return parent
        ? `<p class="parentline">av <b>${esc(parent.es)}</b> = ${esc(parent.sv)}</p>` : "";
    }
    const w = this.store.byId.get(f.kandidat.id);
    if (!w) return "";
    const syns = [...w.syn, ...this.store.userWord(w.id).syn];
    if (!syns.length) return "";
    return `<p class="also">även: <b>${syns.slice(0, 6).map(esc).join("</b> · <b>")}</b></p>`;
  }

  /** Kortets innehåll + kortklass för aktuellt läge. */
  private kort(): { cls: string; html: string } {
    if (this.state === "laddar") {
      return { cls: "st-idle", html: `<p class="pos">Ett ögonblick</p>
        <p class="head" style="font-size:22px">Skriver din text …</p>
        <p class="fine">av orden du håller på att lära dig</p>` };
    }
    if (this.state === "fel") {
      return { cls: "st-hard", html: `<p class="pos">Hoppsan</p>
        <p class="hintled">${esc(this.felText)}</p>` };
    }
    if (this.state === "las") {
      return { cls: "st-idle", html: `<p class="pos">Läs texten — orden kommer sen</p>${this.textHtml()}` };
    }
    if (this.state === "klar") {
      return { cls: "st-good", html: `<p class="verdict v-good">${IC_OK}${this.ratt} av ${this.quiz.length} ord rätt</p>
        <p class="pos" style="margin-top:8px">Läs texten igen — nu sitter orden</p>
        ${this.textHtml()}` };
    }
    const f = this.quiz[this.idx];
    const p = this.pend;
    let html = `<p class="lasmening">${this.markerad(f.mening, f.yta)}</p>
      <p class="head">${esc(f.kandidat.es)}</p>`;
    if (this.state === "fraga" || !p) return { cls: "st-idle", html };
    if (p.grade === "good") {
      return { cls: "st-good", html: html + `<p class="verdict v-good">${IC_OK}Rätt</p>${this.stodLinjer(f)}
        <p class="fine">Enter för nästa</p>` };
    }
    if (p.grade === "hard") {
      return { cls: "st-hard", html: html + `<p class="verdict v-warn">${IC_OK}Rätt — litet stavfel</p>
        <p class="cmp"><code>${this.markedFacit(p.raw, f)}</code></p>
        <p class="fine">Svenskt stavfel — räknas som rätt. Enter för nästa.</p>` };
    }
    let mnemBox = "";
    const mnem = this.store.userWord(f.kandidat.id).mnem
      || this.store.userWord(this.store.formById.get(f.kandidat.id)?.parent ?? "").mnem;
    if (mnem) mnemBox = `<div class="mnembox"><span class="mlabel">Din minnesregel</span><p class="mtext">${esc(mnem)}</p></div>`;
    return { cls: "st-again", html: html + `<p class="verdict v-bad">${IC_X}${p.raw ? "Fel" : "Visste inte"}</p>
      <p class="qline">${esc(f.kandidat.es)} =</p>
      <p class="cmp"><code>${esc(this.facit(f))}</code></p>
      ${this.stodLinjer(f)}${mnemBox}
      <p class="fine">Enter för nästa</p>` };
  }

  /** Knappraden under kortet — bara i lägen utan svarsfält (facit går vidare med Enter/→). */
  private knappHtml(): string {
    if (this.state === "fel") {
      return `<button type="button" class="btn" data-act="retry">Försök igen</button>`;
    }
    if (this.state === "las") {
      return `<button type="button" class="btn" data-act="ord">Vidare till orden</button>`;
    }
    if (this.state === "klar") {
      return `<button type="button" class="btn ghost" data-act="retry">Läs en ny text</button>
        <button type="button" class="btn" data-act="exit-klar">Klart</button>`;
    }
    return "";
  }

  render(): void {
    const { cls, html } = this.kort();
    this.card.className = `card ${cls} lascard`;
    this.card.innerHTML = html;

    const klara = this.state === "klar" ? this.quiz.length : this.idx + (this.state === "svar" ? 1 : 0);
    this.bar.style.width = this.quiz.length ? `${(klara / this.quiz.length) * 100}%` : "0%";
    this.count.textContent = this.state === "fraga" || this.state === "svar"
      ? `${this.idx + 1} / ${this.quiz.length}` : "";
    this.chip.textContent = this.state === "fraga" || this.state === "svar"
      ? "spanska → svenska" : this.state === "klar" ? "läsning klar" : "läsning";

    // svarsfältet är kvar i facit-läget så tangentbordet ligger still; Enter går vidare
    this.form.hidden = this.state !== "fraga" && this.state !== "svar";
    this.vetinte.hidden = this.state !== "fraga";
    const knappar = this.knappHtml();
    this.knappar.hidden = !knappar;
    this.knappar.innerHTML = knappar;
    // klart-knappen lämnar flödet — egen lyssnare eftersom exit ligger utanför data-act
    this.knappar.querySelector('[data-act="exit-klar"]')?.addEventListener("click", () => {
      this.setLive(false);
      this.onExit();
    });
  }
}
