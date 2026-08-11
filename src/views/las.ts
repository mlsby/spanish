import { diffTarget } from "../lib/diff";
import { gradeAnswer, type GradeResult } from "../lib/grading";
import {
  byggQuiz, byggUnderlag, hamtaText, lasCommit, type LasFraga, lasNiva,
} from "../lib/lastext";
import type { Store } from "../lib/store";
import type { SupabaseClient } from "../lib/supabase";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const IC_OK = `<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>`;
const IC_X = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

type LasState = "laddar" | "fel" | "las" | "fraga" | "svar" | "klar";

/**
 * Läsförståelsen: en genererad minitext av användarens egna ord →
 * ordfrågor med meningen som kontext (ordet markerat) → texten igen.
 * Ordsvaren bokförs som riktiga FSRS-repetitioner via lasCommit.
 * Skärmen bygger på passets skelett (pbar/pmeta/cardwrap/answerbar)
 * så att övningarna ser ut och beter sig likadant.
 */
export class LasView {
  private state: LasState = "laddar";
  private meningar: string[] = [];
  private quiz: LasFraga[] = [];
  private idx = 0;
  private ratt = 0;
  private pend: (GradeResult & { raw: string }) | null = null;
  private felText = "";

  constructor(
    private el: HTMLElement,
    private store: Store,
    private sb: SupabaseClient,
    private onExit: () => void,
  ) {
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "exit") { this.setLive(false); this.onExit(); }
      if (act === "retry") void this.start();
      if (act === "ord") { this.state = "fraga"; this.render(); this.focus(); }
      if (act === "giveup") this.svara("");
      if (act === "next") this.nasta();
    });
    el.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = this.el.querySelector<HTMLInputElement>("#lasInput");
      if (input) this.svara(input.value);
    });
    // knappar får aldrig sno fokus från textfältet — annars fälls mobiltangentbordet ihop
    el.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".answerbar button, .vetinte button")) e.preventDefault();
    });
  }

  /** Hämta en ny text och börja om flödet. */
  async start(): Promise<void> {
    this.state = "laddar";
    this.meningar = [];
    this.quiz = [];
    this.idx = 0;
    this.ratt = 0;
    this.pend = null;
    this.render();
    const p = lasNiva(this.store.stats().score);
    // 3× målet: gott om kandidater att välja bland ger naturligare scener (Lucas)
    const underlag = byggUnderlag(this.store, p.anvand * 3);
    if (underlag.kandidater.length === 0) {
      this.felText = "Inga övningsord just nu — öva lite först, sen finns det något att läsa om.";
      this.state = "fel";
      this.render();
      return;
    }
    try {
      const meningar = await hamtaText(this.sb, underlag, {
        meningar: p.meningar,
        anvand: Math.min(p.anvand, underlag.kandidater.length),
      });
      this.meningar = meningar.map((m) => m.es);
      this.quiz = byggQuiz(meningar, underlag.kandidater);
      if (!this.quiz.length) throw new Error("Texten saknade övningsord — prova igen.");
      this.state = "las";
    } catch (e) {
      this.felText = e instanceof Error ? e.message : String(e);
      this.state = "fel";
    }
    this.render();
  }

  private focus(): void {
    this.el.querySelector<HTMLInputElement>("#lasInput")?.focus();
  }

  /** Samma tabbargömning som passet: aktiv övning = ingen flikrad. */
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
    this.render();
  }

  private nasta(): void {
    this.pend = null;
    if (this.idx + 1 < this.quiz.length) {
      this.idx++;
      this.state = "fraga";
      this.render();
      this.focus();
    } else {
      this.store.snapshotToday();
      this.state = "klar";
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

  /** Passets skelett: bar + meta överst, kortet i mitten, knappar/svarsfält under. */
  private skal(procent: number, kortCls: string, kort: string, under: string, chip: string): string {
    const raknare = this.state === "fraga" || this.state === "svar"
      ? `${Math.min(this.idx + 1, this.quiz.length)} / ${this.quiz.length}` : "";
    return `<div class="pass">
      <div>
        <div class="pbar"><i style="width:${procent}%"></i></div>
        <div class="pmeta">
          <button type="button" class="passexit" data-act="exit">
            <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Avsluta
          </button>
          <span class="pcount">${raknare}</span>
          <span class="dirchip">${chip}</span>
        </div>
      </div>
      <div class="cardwrap"><div class="card ${kortCls} lascard">${kort}</div></div>
      ${under}
    </div>`;
  }

  private template(): string {
    if (this.state === "laddar") {
      return `<div class="tomt" style="min-height:60dvh">
        <div class="stor">Skriver din text …</div>
        <p>av orden du håller på att lära dig</p>
        <div class="btnrow" style="max-width:200px">
          <button type="button" class="btn ghost" data-act="exit">Avbryt</button>
        </div></div>`;
    }
    if (this.state === "fel") {
      return `<div class="tomt" style="min-height:60dvh">
        <div class="stor">Hoppsan</div>
        <p>${esc(this.felText)}</p>
        <div class="btnrow" style="max-width:260px">
          <button type="button" class="btn ghost" data-act="exit">Tillbaka</button>
          <button type="button" class="btn" data-act="retry">Försök igen</button>
        </div></div>`;
    }
    if (this.state === "las") {
      return this.skal(0, "st-idle",
        `<p class="pos">Läs texten — orden kommer sen</p>${this.textHtml()}`,
        `<div class="btnrow lasknappar">
          <button type="button" class="btn" data-act="ord">Vidare till orden</button>
        </div>`,
        "läsning");
    }
    if (this.state === "fraga" || this.state === "svar") {
      const f = this.quiz[this.idx];
      const p = this.pend;
      const klara = this.idx + (this.state === "svar" ? 1 : 0);
      let inner = `<p class="lasmening">${this.markerad(f.mening, f.kandidat.es)}</p>
        <p class="head">${esc(f.kandidat.es)}</p>`;
      let cls = "st-idle";
      if (this.state === "svar" && p) {
        if (p.grade === "good") {
          cls = "st-good";
          inner += `<p class="verdict v-good">${IC_OK}Rätt</p>${this.stodLinjer(f)}`;
        } else if (p.grade === "hard") {
          cls = "st-hard";
          inner += `<p class="verdict v-warn">${IC_OK}Rätt — litet stavfel</p>
            <p class="cmp"><code>${this.markedFacit(p.raw, f)}</code></p>
            <p class="fine">Svenskt stavfel — räknas som rätt.</p>`;
        } else {
          cls = "st-again";
          inner += `<p class="verdict v-bad">${IC_X}${p.raw ? "Fel" : "Visste inte"}</p>
            <p class="qline">${esc(f.kandidat.es)} =</p>
            <p class="cmp"><code>${esc(this.facit(f))}</code></p>
            ${this.stodLinjer(f)}`;
          const mnem = this.store.userWord(f.kandidat.id).mnem
            || this.store.userWord(this.store.formById.get(f.kandidat.id)?.parent ?? "").mnem;
          if (mnem) inner += `<div class="mnembox"><span class="mlabel">Din minnesregel</span><p class="mtext">${esc(mnem)}</p></div>`;
        }
      }
      const under = this.state === "fraga"
        ? `<form class="answerbar" id="lasForm" autocomplete="off">
            <input id="lasInput" type="text" inputmode="text" enterkeyhint="send"
              autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Ditt svar">
            <button class="send" type="submit" aria-label="Rätta svaret">
              <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
            </button>
          </form>
          <p class="vetinte"><button type="button" data-act="giveup">vet inte</button></p>`
        : `<div class="btnrow lasknappar">
            <button type="button" class="btn" data-act="next">${this.idx + 1 < this.quiz.length ? "Nästa ord" : "Se texten igen"}</button>
          </div>`;
      return this.skal((klara / this.quiz.length) * 100, cls, inner, under, "spanska → svenska");
    }
    // klar: texten igen, nu med allt färskt i minnet
    return this.skal(100, "st-good",
      `<p class="verdict v-good">${IC_OK}${this.ratt} av ${this.quiz.length} ord rätt</p>
       <p class="pos" style="margin-top:8px">Läs texten igen — nu sitter orden</p>
       ${this.textHtml()}`,
      `<div class="btnrow lasknappar">
        <button type="button" class="btn ghost" data-act="retry">Läs en ny text</button>
        <button type="button" class="btn" data-act="exit">Klart</button>
      </div>`,
      "läsning klar");
  }

  render(): void {
    this.setLive(!["laddar", "fel"].includes(this.state));
    this.el.innerHTML = this.template();
  }
}
