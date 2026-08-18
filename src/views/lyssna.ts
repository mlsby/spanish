import type { SupabaseClient } from "../lib/supabase";
import type { Store } from "../lib/store";
import {
  laddaKurs, laddaTranskript, hamtaLage, sparaLektionslage, sparaAktuell,
  uppdateraBoost, type Lektion, type LyssnaLage, type TranskriptSegment,
} from "../lib/lyssna";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface LyssnaDeps {
  sb: SupabaseClient;
  store: Store;
  inloggad(): boolean;
}

const BASE = import.meta.env.BASE_URL;
const FART_KEY = "lyssna-fart";
const FARTER = [1, 1.25, 1.5, 0.75];

/** Mjuk paus: sessionen hålls vid liv så länge — låsskärmens play funkar hela fönstret. */
const MJUK_FONSTER_MS = 10 * 60 * 1000;
const TYST_MARGINAL_S = 30;
const PULS_MS = 5000;

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// textglyfer (►/❚❚) renderas ojämnt på iOS — riktiga ikoner istället
const PLAY_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const PAUS_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;

/**
 * iOS suspenderar webbprocessen strax efter en riktig paus och då dör
 * låsskärmens play-knapp. Mjuk paus spelar därför tystnad istället.
 * Låsskärmen visar ljudELEMENTETS tid, så tystnaden genereras lång nog
 * att kunna stå parkerad PÅ paus-positionen.
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

async function signadUrl(sb: SupabaseClient, fil: string): Promise<string> {
  const { data, error } = await sb.storage.from("kurs-audio").createSignedUrl(fil, 3600);
  if (error || !data) throw new Error(error?.message ?? "Kunde inte hämta ljudlänk.");
  return data.signedUrl;
}

// ---------- modulstate (överlever fliksbyten) ----------
let kurs: Lektion[] | null = null;
let lage: LyssnaLage | null = null;
let audio: HTMLAudioElement | null = null;
let aktiv: Lektion | null = null;
let tystUrl: string | null = null;
let mjuk: { pos: number; timer: number; puls: number } | null = null;
let molnTimer = 0; // debounce för positions-synk
let audioLektion = 0; // vilken lektion audio.src faktiskt bär — vakt mot skrivningar över lektionsgränser

export async function renderLyssna(el: HTMLElement, deps: LyssnaDeps): Promise<void> {
  if (!deps.inloggad()) {
    el.innerHTML = `<div class="tomt"><div class="stor">Lyssna</div>
      <p>Logga in (på Idag-fliken) så låses kursen upp — 90 lektioner Complete Spanish.</p></div>`;
    return;
  }
  if (!kurs || !lage) {
    el.innerHTML = `<div class="tomt"><p>Hämtar kursen …</p></div>`;
    try {
      [kurs, lage] = await Promise.all([laddaKurs(BASE), hamtaLage(deps.sb)]);
    } catch (e) {
      el.innerHTML = `<div class="tomt"><div class="stor">Hoppsan</div>
        <p>Kunde inte ladda kursen. Har databassteget (migration 0003) körts?</p>
        <p class="omtext">${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
      return;
    }
    if (!lage.aktuell) lage.aktuell = 1;
  }

  const lekt = (n: number) => kurs!.find((x) => x.n === n)!;
  const fart = (): number => Number(localStorage.getItem(FART_KEY) ?? "1");

  el.innerHTML = `
    <div class="lyssna">
      <div class="lytopp">
        <div class="lytitel">Lyssna</div>
        <span class="lykvar" id="lyKvar"></span>
        <button type="button" class="lysokkn" id="lySokKn" aria-label="Sök">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        </button>
        <div class="lysokfalt" id="lySokFalt">
          <input id="lySokIn" type="search" placeholder="Sök" autocomplete="off">
          <button type="button" id="lySokStang" aria-label="Stäng sök">✕</button>
        </div>
      </div>
      <div id="lyFokus"></div>
      <div class="lyrulle" id="lyRulle"></div>
      <div class="lytx" id="lyTx">
        <div class="lytxhuvud">
          <div class="lytxtitel" id="lyTxTitel"></div>
          <button type="button" id="lyTxStang" aria-label="Stäng">✕</button>
        </div>
        <div class="lytxsok"><input id="lyTxSok" type="search" placeholder="Sök i transkriptet" autocomplete="off"></div>
        <div class="lytxrulle" id="lyTxRulle"></div>
      </div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => el.querySelector<T>(`#${id}`)!;

  // ---------- synk ----------
  function sparaMoln(): void {
    if (!aktiv || !lage) return;
    const n = aktiv.n;
    window.clearTimeout(molnTimer);
    molnTimer = window.setTimeout(() => {
      void sparaLektionslage(deps.sb, n, lage!.pos.get(n) ?? 0, lage!.spelade.has(n));
    }, 4000);
  }

  // ---------- gemensamma byggstenar ----------
  const listaHtml = (rader: { es: string; en: string }[]) => rader.map((o) =>
    `<div class="lyordrad"><span class="es">${esc(o.es)}</span><span class="en">${esc(o.en)}</span></div>`).join("");

  function kopplaVaxel(panelEl: HTMLElement, par: [HTMLElement | null, string][]): void {
    for (const [kn, innehall] of par) {
      if (!kn) continue;
      kn.onclick = () => {
        const oppnas = kn.getAttribute("aria-pressed") !== "true";
        for (const [k2] of par) k2?.setAttribute("aria-pressed", "false");
        kn.setAttribute("aria-pressed", String(oppnas));
        panelEl.hidden = !oppnas;
        if (oppnas) panelEl.innerHTML = innehall;
      };
    }
  }

  function nastaOspelad(fran: number): Lektion | null {
    return kurs!.find((x) => x.n > fran && !lage!.spelade.has(x.n))
        ?? kurs!.find((x) => x.n !== fran && !lage!.spelade.has(x.n)) ?? null;
  }

  // ---------- fokuskortet ----------
  function byggFokus(): void {
    const l = lekt(lage!.aktuell);
    const pos = lage!.pos.get(l.n) ?? 0;
    const nasta = nastaOspelad(l.n);
    const spelad = lage!.spelade.has(l.n);
    $("lyFokus").innerHTML = `<div class="lyfokus">
      <div class="lyetikettrad">
        <span class="lyetikett">${spelad ? "Spelad" : "Nu"} · Lektion ${l.n} · ${fmt(l.sek)}</span>
        <button type="button" class="lytystkn" id="lyMark">${spelad ? "avmarkera spelad" : "markera spelad"}</button>
      </div>
      <div class="lyfokustitel">Lektion ${l.n}</div>
      <div class="lyfokusmeta">${l.ord.length} ord · ${l.fraser.length} fraser</div>
      <div class="lykontroller">
        <button type="button" class="lyhopp" id="lyBak" aria-label="Spola tillbaka 15 sekunder">−15</button>
        <button type="button" class="lyplay" id="lyPlay" aria-label="Spela">${PLAY_SVG}</button>
        <button type="button" class="lyhopp" id="lyFram" aria-label="Spola fram 15 sekunder">+15</button>
      </div>
      <div class="lytidrad">
        <span id="lyNu">${fmt(pos)}</span>
        <input type="range" id="lySok" min="0" max="${l.sek}" value="${pos}" step="1" aria-label="Sök i lektionen">
        <span>${fmt(l.sek)}</span>
      </div>
      <div class="lyfot">
        <button type="button" class="lyfart" id="lyFart">${fart()}×</button>
        <button type="button" class="lypill" id="lyOm" aria-pressed="false">Om</button>
        ${l.ord.length ? `<button type="button" class="lypill" id="lyOrd" aria-pressed="false">Ord</button>` : ""}
        ${l.fraser.length ? `<button type="button" class="lypill" id="lyFraser" aria-pressed="false">Fraser</button>` : ""}
        <button type="button" class="lypill" id="lyTxKn">Transkript</button>
      </div>
      <div class="lypanel" id="lyPanel" hidden></div>
      ${nasta ? `<button type="button" class="lynasta" id="lyNasta" data-n="${nasta.n}">Nästa · Lektion ${nasta.n} · ${fmt(nasta.sek)} →</button>` : ""}
    </div>`;
    kopplaFokus(l);
  }

  const spelarNu = () => audio !== null && !audio.paused && mjuk === null && aktiv?.n === lage!.aktuell;

  function uppdateraKnapp(): void {
    const p = el.querySelector<HTMLButtonElement>("#lyPlay");
    if (!p) return;
    p.innerHTML = spelarNu() ? PAUS_SVG : PLAY_SVG;
    p.setAttribute("aria-label", spelarNu() ? "Pausa" : "Spela");
  }

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

  function parkeraITystnad(pos: number): void {
    if (!audio) return;
    if (tystUrl) URL.revokeObjectURL(tystUrl);
    tystUrl = tystnadUrl(pos + TYST_MARGINAL_S);
    audio.src = tystUrl;
    audio.currentTime = pos;
  }

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

  function armaMjuk(pos: number): void {
    if (!audio) return;
    mjuk = {
      pos,
      timer: window.setTimeout(hardPaus, MJUK_FONSTER_MS),
      puls: window.setInterval(() => {
        if (!audio || !mjuk) return;
        if (mjuk.pos + TYST_MARGINAL_S > (audio.duration || 0)) parkeraITystnad(mjuk.pos);
        else audio.currentTime = mjuk.pos;
        posState(mjuk.pos);
      }, PULS_MS),
    };
    parkeraITystnad(pos);
    void audio.play().catch(hardPaus);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    posState(pos);
    uppdateraKnapp();
  }

  function mjukPaus(): void {
    if (!audio || !aktiv || mjuk) return;
    const pos = Math.min(audio.currentTime, aktiv.sek);
    lage!.pos.set(aktiv.n, Math.floor(pos));
    void sparaLektionslage(deps.sb, aktiv.n, pos, lage!.spelade.has(aktiv.n));
    armaMjuk(pos);
  }

  async function spelaFran(pos: number): Promise<void> {
    if (!aktiv) return;
    slappMjuk();
    sakraAudio();
    audio!.loop = false;
    try {
      audio!.src = await signadUrl(deps.sb, aktiv.fil);
    } catch (e) {
      const t = el.querySelector(".lyfokustitel");
      if (t) t.textContent = `Lektion ${aktiv.n} — kunde inte hämtas (${e instanceof Error ? e.message : e})`;
      return;
    }
    audioLektion = aktiv.n;
    audio!.currentTime = pos;
    audio!.playbackRate = fart();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `Lektion ${aktiv.n}`,
        artist: "Complete Spanish · Language Transfer",
        album: "Glosa",
        // explicit fullbleed-bild — annars ramar iOS in favicon med vit platta
        artwork: [
          { src: new URL(`${BASE}icon-512.png`, location.origin).href, sizes: "512x512", type: "image/png" },
          { src: new URL(`${BASE}icon-1024.png`, location.origin).href, sizes: "1024x1024", type: "image/png" },
        ],
      });
    }
    await audio!.play().catch(() => { /* autoplay-stopp är ok — play-knappen finns */ });
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    posState(pos);
    uppdateraKnapp();
  }

  const posNu = (): number => (mjuk ? mjuk.pos : Math.min(audio?.currentTime ?? 0, aktiv?.sek ?? 0));

  function sokTill(pos: number): void {
    if (!aktiv) return;
    const p = Math.max(0, Math.min(pos, aktiv.sek));
    if (mjuk) {
      mjuk.pos = p;
      if (audio) {
        if (p + TYST_MARGINAL_S > (audio.duration || 0)) parkeraITystnad(p);
        else audio.currentTime = p;
      }
    } else if (audio && aktiv.n === lage!.aktuell) {
      audio.currentTime = p;
    }
    lage!.pos.set(aktiv.n, Math.floor(p));
    sparaMoln();
    const sok = el.querySelector<HTMLInputElement>("#lySok");
    const nu = el.querySelector("#lyNu");
    if (sok) sok.value = String(p);
    if (nu) nu.textContent = fmt(p);
    posState(p);
  }

  function toggla(): void {
    if (!aktiv) return;
    if (mjuk) { void spelaFran(mjuk.pos); return; }
    if (audio && !audio.paused) { mjukPaus(); return; }
    void spelaFran(lage!.pos.get(aktiv.n) ?? 0);
  }

  function sakraAudio(): void {
    if (audio) return;
    audio = new Audio();
    audio.ontimeupdate = () => {
      if (!aktiv || !audio || mjuk) return;
      if (audioLektion !== aktiv.n) return; // gammalt ljud hinner ticka under lektionsbyte
      const sok = el.querySelector<HTMLInputElement>("#lySok");
      const nu = el.querySelector("#lyNu");
      if (sok && aktiv.n === lage!.aktuell) { sok.value = String(audio.currentTime); }
      if (nu && aktiv.n === lage!.aktuell) { nu.textContent = fmt(audio.currentTime); }
      lage!.pos.set(aktiv.n, Math.floor(audio.currentTime));
      sparaMoln();
      // 95 % räknas som spelad — sista sekunderna är utro
      if (audio.currentTime > aktiv.sek * 0.95 && !lage!.spelade.has(aktiv.n)) {
        lage!.spelade.add(aktiv.n);
        void sparaLektionslage(deps.sb, aktiv.n, audio.currentTime, true);
        void uppdateraBoost(deps.store, deps.sb, BASE);
        byggLista();
      }
      posState(audio.currentTime);
      foljTx();
    };
    audio.onplay = uppdateraKnapp;
    audio.onpause = uppdateraKnapp;
    // lektionen tog slut: nästa ospelade armas i mjuk paus — låsskärmens play startar den
    audio.onended = () => {
      if (!aktiv || mjuk || audioLektion !== aktiv.n) return;
      lage!.spelade.add(aktiv.n);
      void sparaLektionslage(deps.sb, aktiv.n, aktiv.sek, true);
      void uppdateraBoost(deps.store, deps.sb, BASE);
      const nasta = nastaOspelad(aktiv.n);
      if (!nasta) { byggFokus(); byggLista(); return; }
      valjAktuell(nasta.n, false);
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

  function kopplaFokus(l: Lektion): void {
    $("lyPlay").onclick = toggla;
    $("lyBak").onclick = () => sokTill(posNu() - 15);
    $("lyFram").onclick = () => sokTill(posNu() + 15);
    $<HTMLInputElement>("lySok").oninput = () => sokTill(Number($<HTMLInputElement>("lySok").value));
    $("lyFart").onclick = () => {
      const f = FARTER[(FARTER.indexOf(fart()) + 1) % FARTER.length];
      localStorage.setItem(FART_KEY, String(f));
      if (audio && !mjuk) audio.playbackRate = f;
      $("lyFart").textContent = f + "×";
      posState(posNu());
    };
    kopplaVaxel($("lyPanel"), [
      [el.querySelector("#lyOm"), `<div class="lyfokusom">${esc(l.om)}</div>`],
      [el.querySelector("#lyOrd"), listaHtml(l.ord)],
      [el.querySelector("#lyFraser"), listaHtml(l.fraser)],
    ]);
    $("lyTxKn").onclick = () => void oppnaTx(l.n);
    $("lyMark").onclick = () => {
      const spelad = !lage!.spelade.has(l.n);
      if (spelad) lage!.spelade.add(l.n); else lage!.spelade.delete(l.n);
      void sparaLektionslage(deps.sb, l.n, lage!.pos.get(l.n) ?? 0, spelad);
      void uppdateraBoost(deps.store, deps.sb, BASE);
      // klar med den man lyssnar på -> hoppa direkt till nästa ospelade
      const nasta = spelad ? nastaOspelad(l.n) : null;
      if (nasta) { valjAktuell(nasta.n, spelarNu()); return; }
      byggFokus(); byggLista();
    };
    const nastaKn = el.querySelector<HTMLButtonElement>("#lyNasta");
    if (nastaKn) nastaKn.onclick = () => valjAktuell(Number(nastaKn.dataset.n), false);
  }

  /** Byt aktuell lektion; autoplay startar den direkt. */
  function valjAktuell(n: number, autoplay: boolean): void {
    slappMjuk();
    audio?.pause(); // stoppa gamla lektionens ljud INNAN bytet — annars tickar det in i nya
    lage!.aktuell = n;
    aktiv = lekt(n);
    void sparaAktuell(deps.sb, n);
    byggFokus();
    byggLista();
    if (autoplay) void spelaFran(lage!.pos.get(n) ?? 0);
  }

  // ---------- listan ----------
  let oppenRad: HTMLElement | null = null;

  function radHtml(l: Lektion): string {
    const spelad = lage!.spelade.has(l.n);
    const nu = l.n === lage!.aktuell;
    return `<button type="button" class="lyrad${spelad ? " spelad" : ""}${nu ? " nu" : ""}" data-n="${l.n}">
      <span class="nr">Lektion ${l.n}</span>
      <span class="meta">${fmt(l.sek)}${l.ord.length ? ` · ${l.ord.length} ord` : ""}${l.fraser.length ? ` · ${l.fraser.length} fraser` : ""}</span>
      <span class="st">${nu ? "▸" : spelad ? "✓" : ""}</span>
    </button>`;
  }

  function byggLista(): void {
    $("lyKvar").textContent = `${lage!.spelade.size} av ${kurs!.length} spelade`;
    const rulle = $("lyRulle");
    rulle.innerHTML = kurs!.map(radHtml).join("");
    const aktRad = rulle.querySelector<HTMLElement>(`.lyrad[data-n="${lage!.aktuell}"]`);
    if (aktRad) rulle.scrollTop = aktRad.offsetTop - rulle.offsetTop;
    rulle.querySelectorAll<HTMLButtonElement>(".lyrad").forEach((b) =>
      b.onclick = () => vaxlaRad(Number(b.dataset.n), b));
    oppenRad = null;
  }

  function vaxlaRad(n: number, radEl: HTMLElement): void {
    if (n === lage!.aktuell) return; // aktuella lektionen har redan spelaren ovanför
    if (oppenRad?.dataset.n === String(n)) { stangRad(); return; }
    stangRad();
    const l = lekt(n);
    const u = document.createElement("div");
    u.className = "lyutfall";
    u.innerHTML = `<div class="om">${esc(l.om)}</div>
      <div class="knappar">
        <button type="button" class="lyspelakn">▶ Spela</button>
        ${l.ord.length ? `<button type="button" class="lypill" data-p="ord" aria-pressed="false">Ord</button>` : ""}
        ${l.fraser.length ? `<button type="button" class="lypill" data-p="fraser" aria-pressed="false">Fraser</button>` : ""}
        <button type="button" class="lypill" data-p="tx">Transkript</button>
        <button type="button" class="lytystkn">${lage!.spelade.has(n) ? "avmarkera spelad" : "markera som spelad"}</button>
      </div>
      <div class="lypanel" hidden></div>`;
    radEl.after(u);
    radEl.classList.add("oppen");
    kopplaVaxel(u.querySelector<HTMLElement>(".lypanel")!, [
      [u.querySelector('[data-p="ord"]'), listaHtml(l.ord)],
      [u.querySelector('[data-p="fraser"]'), listaHtml(l.fraser)],
    ]);
    u.querySelector<HTMLButtonElement>('[data-p="tx"]')!.onclick = () => void oppnaTx(n);
    u.querySelector<HTMLButtonElement>(".lyspelakn")!.onclick = () => valjAktuell(n, true);
    u.querySelector<HTMLButtonElement>(".lytystkn")!.onclick = () => {
      const spelad = !lage!.spelade.has(n);
      if (spelad) lage!.spelade.add(n); else lage!.spelade.delete(n);
      void sparaLektionslage(deps.sb, n, lage!.pos.get(n) ?? 0, spelad);
      void uppdateraBoost(deps.store, deps.sb, BASE);
      byggFokus(); byggLista();
    };
    oppenRad = radEl;
    // lyft raden till scrollområdets topp så hela utfället syns
    const rulle = $("lyRulle");
    rulle.scrollTo({ top: radEl.offsetTop - rulle.offsetTop, behavior: "smooth" });
  }

  function stangRad(): void {
    el.querySelector(".lyutfall")?.remove();
    oppenRad?.classList.remove("oppen");
    oppenRad = null;
  }

  // ---------- sök ----------
  $("lySokKn").onclick = () => {
    $("lySokFalt").classList.add("pa");
    $("lyFokus").hidden = true; // spelaren lämnar plats åt träffarna
    $<HTMLInputElement>("lySokIn").focus();
  };
  $("lySokStang").onclick = () => {
    $("lySokFalt").classList.remove("pa");
    $("lyFokus").hidden = false;
    $<HTMLInputElement>("lySokIn").value = "";
    byggLista();
  };
  $<HTMLInputElement>("lySokIn").oninput = () => visaSok($<HTMLInputElement>("lySokIn").value.trim());

  function visaSok(q: string): void {
    if (!q) { byggLista(); return; }
    const Q = q.toLowerCase();
    const rx = new RegExp(`(${Q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
    const hl = (s: string) => esc(s).replace(rx, "<mark>$1</mark>");
    let html = "";
    const lektT = kurs!.filter((l) => (l.om + " " + l.koncept.join(" ")).toLowerCase().includes(Q));
    if (lektT.length) html += `<div class="lygrupp">Lektioner</div>` + lektT.slice(0, 6).map((l) =>
      `<button type="button" class="lytraff" data-n="${l.n}"><span class="var">lekt ${l.n}</span><span class="en">${hl(l.om)}</span></button>`).join("");
    const ord: ({ es: string; en: string; n: number })[] = [];
    for (const l of kurs!) for (const o of l.ord)
      if ((o.es + " " + o.en).toLowerCase().includes(Q)) ord.push({ ...o, n: l.n });
    if (ord.length) html += `<div class="lygrupp">Ord — introduceras i</div>` + ord.slice(0, 8).map((o) =>
      `<button type="button" class="lytraff" data-n="${o.n}"><span class="es">${hl(o.es)}</span><span class="en">${hl(o.en)}</span><span class="var">lekt ${o.n}</span></button>`).join("");
    const fraser: ({ es: string; en: string; n: number })[] = [];
    for (const l of kurs!) for (const f of l.fraser)
      if ((f.es + " " + f.en).toLowerCase().includes(Q)) fraser.push({ ...f, n: l.n });
    if (fraser.length) html += `<div class="lygrupp">Fraser</div>` + fraser.slice(0, 6).map((f) =>
      `<button type="button" class="lytraff" data-n="${f.n}"><span class="es">${hl(f.es)}</span><span class="en">${hl(f.en)}</span><span class="var">lekt ${f.n}</span></button>`).join("");
    const rulle = $("lyRulle");
    rulle.innerHTML = html || `<div class="lytomtraff">Inget hittat i lektionskartorna.</div>`;
    rulle.scrollTop = 0;
    rulle.querySelectorAll<HTMLButtonElement>(".lytraff").forEach((b) => b.onclick = () => {
      $("lySokFalt").classList.remove("pa");
      $("lyFokus").hidden = false;
      $<HTMLInputElement>("lySokIn").value = "";
      valjAktuell(Number(b.dataset.n), false);
    });
  }

  // ---------- transkript ----------
  let txN = 0;
  let txSegs: TranskriptSegment[] = [];

  async function oppnaTx(n: number): Promise<void> {
    const tx = $("lyTx");
    if (txN !== n) {
      $("lyTxTitel").textContent = `Lektion ${n} — transkript`;
      $("lyTxRulle").innerHTML = `<div class="lytomtraff">Hämtar …</div>`;
      tx.classList.add("pa");
      try {
        txSegs = await laddaTranskript(BASE, n);
      } catch (e) {
        $("lyTxRulle").innerHTML = `<div class="lytomtraff">Kunde inte hämta transkriptet (${esc(e instanceof Error ? e.message : String(e))})</div>`;
        return;
      }
      $<HTMLInputElement>("lyTxSok").value = "";
      $("lyTxRulle").innerHTML = txSegs.map((s) => `
        <div class="lyseg" data-start="${s.start}">
          <span class="t">${fmt(s.start)}</span>
          <span class="vem ${s.speaker === "Teacher" ? "T" : "S"}">${s.speaker === "Teacher" ? "M" : "E"}</span>
          <span class="text">${esc(s.text)}</span></div>`).join("");
      $("lyTxRulle").querySelectorAll<HTMLElement>(".lyseg").forEach((seg) =>
        seg.onclick = () => {
          if (lage!.aktuell !== n) valjAktuell(n, false);
          void spelaFran(Number(seg.dataset.start));
        });
      txN = n;
    } else {
      tx.classList.add("pa");
    }
  }
  $("lyTxStang").onclick = () => $("lyTx").classList.remove("pa");
  $<HTMLInputElement>("lyTxSok").oninput = () => {
    const q = $<HTMLInputElement>("lyTxSok").value.trim().toLowerCase();
    const rx = q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig") : null;
    $("lyTxRulle").querySelectorAll<HTMLElement>(".lyseg").forEach((seg, i) => {
      const s = txSegs[i];
      const traff = rx !== null && s.text.toLowerCase().includes(q);
      seg.style.display = !q || traff ? "" : "none";
      seg.querySelector(".text")!.innerHTML = traff && rx ? esc(s.text).replace(rx, "<mark>$1</mark>") : esc(s.text);
    });
  };
  function foljTx(): void {
    if (!aktiv || txN !== aktiv.n || !$("lyTx").classList.contains("pa")) return;
    if ($<HTMLInputElement>("lyTxSok").value) return;
    const t = audio?.currentTime ?? 0;
    const i = txSegs.findIndex((s) => t >= s.start && t < s.end);
    $("lyTxRulle").querySelectorAll(".lyseg").forEach((seg, j) => seg.classList.toggle("nu", j === i));
    $("lyTxRulle").querySelector(".lyseg.nu")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // ---------- igång ----------
  aktiv = lekt(lage.aktuell);
  byggFokus();
  byggLista();
  uppdateraKnapp();
}
