import type { SupabaseClient } from "../lib/supabase";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Lektion {
  n: number;
  fil: string;
  sek: number;
  om: string;
  ord: { es: string; en: string }[];
  fraser: { es: string; en: string }[];
  koncept: string[];
}

interface Kurs {
  kurs: string;
  lektioner: Lektion[];
}

export interface LyssnaDeps {
  sb: SupabaseClient;
  inloggad(): boolean;
}

const POS_KEY = (n: number) => `lyssna-pos-${n}`;
const KLAR_KEY = (n: number) => `lyssna-klar-${n}`;
const SENAST_KEY = "lyssna-senast";
const FART_KEY = "lyssna-fart";

/** Mjuk paus: sessionen hålls vid liv så länge — låsskärmens play funkar hela fönstret. */
const MJUK_FONSTER_MS = 10 * 60 * 1000;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * iOS suspenderar webbprocessen strax efter en riktig paus och då dör
 * låsskärmens play-knapp. Mjuk paus spelar därför tystnad istället —
 * sessionen lever, processen får köra, och play funkar från låsskärmen.
 *
 * Låsskärmen visar ljudELEMENTETS tid, så tystnaden måste vara lång nog
 * att kunna stå PÅ paus-positionen — annars visas tystnadsfilens 0:00.
 */
function tystnadUrl(sekunder: number): string {
  const sr = 8000, n = sr * Math.ceil(sekunder); // 8-bit mono PCM = 8 kB/s
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o: number, str: string) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, "data"); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit: 128 = tystnad
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/** Marginal ovanpå paus-positionen så pulsen alltid hinner dra tillbaka tiden. */
const TYST_MARGINAL_S = 30;
const PULS_MS = 5000;

let kurs: Kurs | null = null;
let audio: HTMLAudioElement | null = null;
let aktiv: Lektion | null = null;
let tystUrl: string | null = null;
/** Satt under mjuk paus: positionen att återuppta på, fönstertimern och pulsen som parkerar tiden. */
let mjuk: { pos: number; timer: number; puls: number } | null = null;

/** Byt tystnadskälla och parkera elementet på pos — släpper gamla bufferten. */
function parkeraITystnad(pos: number): void {
  if (!audio) return;
  if (tystUrl) URL.revokeObjectURL(tystUrl);
  tystUrl = tystnadUrl(pos + TYST_MARGINAL_S);
  audio.src = tystUrl;
  audio.currentTime = pos;
}

/** Signerad URL — bucketen är privat, RLS släpper bara in inloggade. */
async function signadUrl(sb: SupabaseClient, fil: string): Promise<string> {
  const { data, error } = await sb.storage.from("kurs-audio").createSignedUrl(fil, 3600);
  if (error || !data) throw new Error(error?.message ?? "Kunde inte hämta ljudlänk.");
  return data.signedUrl;
}

export async function renderLyssna(el: HTMLElement, deps: LyssnaDeps): Promise<void> {
  if (!deps.inloggad()) {
    el.innerHTML = `<div class="tomt"><div class="stor">Lyssna</div>
      <p>Logga in (på Idag-fliken) så låses kursen upp — 90 lektioner Complete Spanish.</p></div>`;
    return;
  }
  if (!kurs) {
    el.innerHTML = `<div class="tomt"><p>Hämtar kursen …</p></div>`;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/kurs.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      kurs = (await res.json()) as Kurs;
    } catch (e) {
      el.innerHTML = `<div class="tomt"><div class="stor">Hoppsan</div>
        <p>Kunde inte ladda kursdatan. Kontrollera nätverket och försök igen.</p>
        <p class="omtext">${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
      return;
    }
  }

  const senast = Number(localStorage.getItem(SENAST_KEY) ?? "0");
  el.innerHTML = `
    <div class="lyssna">
      <div class="lyssnahuvud">
        <div class="stor">Lyssna</div>
        <p class="omtext">Complete Spanish · Language Transfer · ${kurs.lektioner.length} lektioner</p>
      </div>
      <div class="spelare" id="spelare" hidden>
        <div class="spelartitel" id="spTitel"></div>
        <div class="spelarrad">
          <button type="button" class="sphopp" id="spBak" aria-label="Spola tillbaka 15 sekunder">−15</button>
          <button type="button" class="spplay" id="spPlay" aria-label="Spela">►</button>
          <button type="button" class="sphopp" id="spFram" aria-label="Spola fram 15 sekunder">+15</button>
        </div>
        <div class="spelartid">
          <span id="spNu">0:00</span>
          <input type="range" id="spSok" min="0" max="100" value="0" step="1" aria-label="Sök i lektionen">
          <span id="spTot">0:00</span>
        </div>
        <div class="spelarfart" role="group" aria-label="Hastighet">
          ${[0.75, 1, 1.25, 1.5].map((r) => `<button type="button" data-fart="${r}" aria-pressed="${r === 1}">${r}×</button>`).join("")}
        </div>
      </div>
      <div class="lektionlista">
        ${kurs.lektioner.map((l) => {
          const pos = Number(localStorage.getItem(POS_KEY(l.n)) ?? "0");
          const klar = localStorage.getItem(KLAR_KEY(l.n)) === "1";
          const status = klar ? "✓" : pos > 30 ? fmt(pos) : "";
          return `<button type="button" class="lektion${l.n === senast ? " senast" : ""}" data-n="${l.n}">
            <span class="leknr">${l.n}</span>
            <span class="lekmitt">
              <span class="lekom">${esc(l.om.split(". ")[0])}.</span>
              <span class="lekmeta">${fmt(l.sek)} · ${l.ord.length} ord · ${l.fraser.length} fraser</span>
            </span>
            <span class="lekstatus${klar ? " klar" : ""}">${status}</span>
          </button>`;
        }).join("")}
      </div>
    </div>`;

  const spelare = el.querySelector<HTMLElement>("#spelare")!;
  const spTitel = el.querySelector<HTMLElement>("#spTitel")!;
  const spPlay = el.querySelector<HTMLButtonElement>("#spPlay")!;
  const spBak = el.querySelector<HTMLButtonElement>("#spBak")!;
  const spFram = el.querySelector<HTMLButtonElement>("#spFram")!;
  const spSok = el.querySelector<HTMLInputElement>("#spSok")!;
  const spNu = el.querySelector<HTMLElement>("#spNu")!;
  const spTot = el.querySelector<HTMLElement>("#spTot")!;

  const spelarNu = () => audio !== null && !audio.paused && mjuk === null;

  function uppdateraKnapp(): void {
    spPlay.textContent = spelarNu() ? "❚❚" : "►";
    spPlay.setAttribute("aria-label", spelarNu() ? "Pausa" : "Spela");
  }

  /** Låsskärmens förloppsindikator + scrubbing. */
  function posState(pos: number): void {
    if (!("mediaSession" in navigator) || !aktiv) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: aktiv.sek,
        position: Math.min(pos, aktiv.sek),
        playbackRate: mjuk ? 1 : (audio?.playbackRate ?? 1),
      });
    } catch { /* trasig position får aldrig stoppa uppspelningen */ }
  }

  function visaLektionIUi(l: Lektion, pos: number): void {
    spelare.hidden = false;
    spTitel.textContent = `Lektion ${l.n}`;
    spTot.textContent = fmt(l.sek);
    spSok.max = String(l.sek);
    spSok.value = String(pos);
    spNu.textContent = fmt(pos);
    el.querySelectorAll(".lektion").forEach((b) =>
      b.classList.toggle("senast", (b as HTMLElement).dataset.n === String(l.n)));
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `Lektion ${l.n}`,
        artist: "Complete Spanish · Language Transfer",
        album: "Glosa",
      });
    }
  }

  /** Riktig paus — efter mjuka fönstret. Härifrån krävs app-öppning (iOS suspenderar). */
  function slappMjuk(): void {
    if (!mjuk) return;
    window.clearTimeout(mjuk.timer);
    window.clearInterval(mjuk.puls);
    mjuk = null;
  }

  function hardPaus(): void {
    slappMjuk();
    audio?.pause();
    uppdateraKnapp();
  }

  /** Mjuk paus: parkera i tystnad på paus-positionen och håll sessionen vid liv i 10 min. */
  function armaMjuk(pos: number): void {
    if (!audio) return;
    mjuk = {
      pos,
      timer: window.setTimeout(hardPaus, MJUK_FONSTER_MS),
      // parkera tiden på pos igen och igen — låsskärmen ska stå still där
      puls: window.setInterval(() => {
        if (!audio || !mjuk) return;
        if (mjuk.pos + TYST_MARGINAL_S > (audio.duration || 0)) parkeraITystnad(mjuk.pos); // scrubbad förbi bufferten
        else audio.currentTime = mjuk.pos;
        posState(mjuk.pos);
      }, PULS_MS),
    };
    parkeraITystnad(pos);
    void audio.play().catch(hardPaus); // kan tystnaden inte spela är riktig paus ärligare
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    posState(pos);
    uppdateraKnapp();
  }

  function mjukPaus(): void {
    if (!audio || !aktiv || mjuk) return;
    const pos = Math.min(audio.currentTime, aktiv.sek);
    localStorage.setItem(POS_KEY(aktiv.n), String(Math.floor(pos)));
    armaMjuk(pos);
  }

  /** Spela aktiv lektion från pos — signerar alltid om (länken kan ha hunnit gå ut). */
  async function spelaFran(pos: number): Promise<void> {
    if (!audio || !aktiv) return;
    slappMjuk();
    audio.loop = false;
    try {
      audio.src = await signadUrl(deps.sb, aktiv.fil);
    } catch (e) {
      spTitel.textContent = `Lektion ${aktiv.n} — kunde inte hämtas (${e instanceof Error ? e.message : e})`;
      return;
    }
    audio.currentTime = pos;
    audio.playbackRate = Number(localStorage.getItem(FART_KEY) ?? "1");
    await audio.play().catch(() => { /* autoplay-stopp är ok — play-knappen finns */ });
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    posState(pos);
    uppdateraKnapp();
  }

  function toggla(): void {
    if (!aktiv) return;
    if (!audio) { void valjLektion(aktiv); return; } // första trycket efter sidladdning
    if (mjuk) { void spelaFran(mjuk.pos); return; }
    if (!audio.paused) { mjukPaus(); return; }
    void spelaFran(Math.min(audio.currentTime, aktiv.sek));
  }

  /** Nuvarande lyssningsposition oavsett läge. */
  const posNu = (): number => (mjuk ? mjuk.pos : Math.min(audio?.currentTime ?? 0, aktiv?.sek ?? 0));

  function sokTill(pos: number): void {
    if (!aktiv) return;
    const p = Math.max(0, Math.min(pos, aktiv.sek));
    if (mjuk) {
      mjuk.pos = p; // spola under mjuk paus flyttar märket — och parkerar om tystnaden där
      localStorage.setItem(POS_KEY(aktiv.n), String(Math.floor(p)));
      if (audio) {
        if (p + TYST_MARGINAL_S > (audio.duration || 0)) parkeraITystnad(p);
        else audio.currentTime = p;
      }
    } else if (audio) {
      audio.currentTime = p;
    }
    spSok.value = String(p);
    spNu.textContent = fmt(p);
    posState(p);
  }

  async function valjLektion(l: Lektion, autoplay = true): Promise<void> {
    slappMjuk();
    aktiv = l;
    localStorage.setItem(SENAST_KEY, String(l.n));
    const pos = Number(localStorage.getItem(POS_KEY(l.n)) ?? "0");
    visaLektionIUi(l, pos);

    if (!audio) {
      audio = new Audio();
      audio.ontimeupdate = () => {
        if (!aktiv || !audio || mjuk) return; // tysta loopens tid är inte lektionens
        spSok.value = String(audio.currentTime);
        spNu.textContent = fmt(audio.currentTime);
        localStorage.setItem(POS_KEY(aktiv.n), String(Math.floor(audio.currentTime)));
        // 95 % räknas som lyssnad — sista sekunderna är utro
        if (audio.currentTime > aktiv.sek * 0.95) localStorage.setItem(KLAR_KEY(aktiv.n), "1");
        posState(audio.currentTime);
      };
      audio.onplay = uppdateraKnapp;
      audio.onpause = uppdateraKnapp;
      // lektionen tog slut: ladda nästa i mjuk paus — låsskärmens play startar den direkt
      audio.onended = () => {
        if (!aktiv || mjuk) return;
        localStorage.setItem(KLAR_KEY(aktiv.n), "1");
        const nasta = kurs?.lektioner.find((x) => x.n === aktiv!.n + 1);
        if (!nasta) { uppdateraKnapp(); return; }
        aktiv = nasta;
        localStorage.setItem(SENAST_KEY, String(nasta.n));
        localStorage.setItem(POS_KEY(nasta.n), "0");
        visaLektionIUi(nasta, 0);
        armaMjuk(0);
      };
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", () => { if (!spelarNu()) toggla(); });
        navigator.mediaSession.setActionHandler("pause", () => { if (spelarNu()) toggla(); });
        navigator.mediaSession.setActionHandler("seekbackward", () => sokTill(posNu() - 15));
        navigator.mediaSession.setActionHandler("seekforward", () => sokTill(posNu() + 15));
        navigator.mediaSession.setActionHandler("seekto", (e) => { if (e.seekTime != null) sokTill(e.seekTime); });
      }
    }
    if (autoplay) await spelaFran(pos);
  }

  spPlay.onclick = toggla;
  spBak.onclick = () => sokTill(posNu() - 15);
  spFram.onclick = () => sokTill(posNu() + 15);
  spSok.oninput = () => sokTill(Number(spSok.value));
  el.querySelectorAll<HTMLButtonElement>("[data-fart]").forEach((b) => {
    b.onclick = () => {
      const fart = Number(b.dataset.fart);
      if (audio && !mjuk) audio.playbackRate = fart;
      localStorage.setItem(FART_KEY, String(fart));
      el.querySelectorAll("[data-fart]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      posState(posNu());
    };
  });
  el.querySelectorAll<HTMLButtonElement>(".lektion").forEach((b) => {
    b.onclick = () => {
      const l = kurs!.lektioner.find((x) => x.n === Number(b.dataset.n));
      if (l) void valjLektion(l);
    };
  });

  // visa senaste lektionen i spelaren (utan autoplay) så resume är ett tryck bort
  if (senast) {
    const l = kurs.lektioner.find((x) => x.n === senast);
    if (l) {
      aktiv = l;
      visaLektionIUi(l, Number(localStorage.getItem(POS_KEY(l.n)) ?? "0"));
      uppdateraKnapp();
    }
  }
}
