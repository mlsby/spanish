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

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

let kurs: Kurs | null = null;
let audio: HTMLAudioElement | null = null;
let aktiv: Lektion | null = null;

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

  function uppdateraKnapp(): void {
    const spelar = audio !== null && !audio.paused;
    spPlay.textContent = spelar ? "❚❚" : "►";
    spPlay.setAttribute("aria-label", spelar ? "Pausa" : "Spela");
  }

  const togglaPlay = () => { if (audio) { audio.paused ? void audio.play() : audio.pause(); } };

  async function valjLektion(l: Lektion): Promise<void> {
    aktiv = l;
    spPlay.onclick = togglaPlay; // resume-läget kan ha lånat knappen — ta tillbaka den
    localStorage.setItem(SENAST_KEY, String(l.n));
    spelare.hidden = false;
    spTitel.textContent = `Lektion ${l.n}`;
    spTot.textContent = fmt(l.sek);
    spSok.max = String(l.sek);
    el.querySelectorAll(".lektion").forEach((b) =>
      b.classList.toggle("senast", (b as HTMLElement).dataset.n === String(l.n)));

    audio?.pause();
    audio ??= new Audio();
    try {
      audio.src = await signadUrl(deps.sb, l.fil);
    } catch (e) {
      spTitel.textContent = `Lektion ${l.n} — kunde inte hämtas (${e instanceof Error ? e.message : e})`;
      return;
    }
    audio.currentTime = Number(localStorage.getItem(POS_KEY(l.n)) ?? "0");
    audio.playbackRate = Number(localStorage.getItem(FART_KEY) ?? "1");

    audio.ontimeupdate = () => {
      if (!aktiv || !audio) return;
      spSok.value = String(audio.currentTime);
      spNu.textContent = fmt(audio.currentTime);
      localStorage.setItem(POS_KEY(aktiv.n), String(Math.floor(audio.currentTime)));
      // 95 % räknas som lyssnad — sista sekunderna är utro
      if (audio.currentTime > aktiv.sek * 0.95) localStorage.setItem(KLAR_KEY(aktiv.n), "1");
    };
    audio.onplay = uppdateraKnapp;
    audio.onpause = uppdateraKnapp;

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `Lektion ${l.n}`,
        artist: "Complete Spanish · Language Transfer",
        album: "Glosa",
      });
      navigator.mediaSession.setActionHandler("play", () => void audio?.play());
      navigator.mediaSession.setActionHandler("pause", () => audio?.pause());
      navigator.mediaSession.setActionHandler("seekbackward", () => spBak.click());
      navigator.mediaSession.setActionHandler("seekforward", () => spFram.click());
      navigator.mediaSession.setActionHandler("seekto", (e) => {
        if (audio && e.seekTime != null) audio.currentTime = e.seekTime;
      });
    }
    void audio.play().catch(() => uppdateraKnapp()); // autoplay-stopp är ok — play-knappen finns
    uppdateraKnapp();
  }

  spPlay.onclick = togglaPlay;
  spBak.onclick = () => { if (audio) audio.currentTime = Math.max(0, audio.currentTime - 15); };
  spFram.onclick = () => { if (audio && aktiv) audio.currentTime = Math.min(aktiv.sek, audio.currentTime + 15); };
  spSok.oninput = () => { if (audio) audio.currentTime = Number(spSok.value); };
  el.querySelectorAll<HTMLButtonElement>("[data-fart]").forEach((b) => {
    b.onclick = () => {
      const fart = Number(b.dataset.fart);
      if (audio) audio.playbackRate = fart;
      localStorage.setItem(FART_KEY, String(fart));
      el.querySelectorAll("[data-fart]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    };
  });
  el.querySelectorAll<HTMLButtonElement>(".lektion").forEach((b) => {
    b.onclick = () => {
      const l = kurs!.lektioner.find((x) => x.n === Number(b.dataset.n));
      if (l) void valjLektion(l);
    };
  });

  // återuppta senaste lektionen i spelaren (utan autoplay) om en fanns
  if (senast) {
    const l = kurs.lektioner.find((x) => x.n === senast);
    if (l) {
      spelare.hidden = false;
      spTitel.textContent = `Lektion ${l.n}`;
      spTot.textContent = fmt(l.sek);
      spSok.max = String(l.sek);
      spSok.value = localStorage.getItem(POS_KEY(l.n)) ?? "0";
      spNu.textContent = fmt(Number(spSok.value));
      const starta = () => void valjLektion(l);
      spPlay.onclick = starta; // första trycket laddar; valjLektion tar sedan över handlarna
    }
  }
}
