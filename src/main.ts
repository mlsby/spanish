import "./styles.css";
import { Store } from "./lib/store";
import { initViewportFit } from "./lib/viewport";
import { requestPersistence } from "./lib/storage";
import { createSupabase } from "./lib/supabase";
import { parseLoginInput } from "./lib/logintoken";
import { loadPass } from "./lib/passpaus";
import { CloudSync } from "./lib/sync";
import { Social } from "./lib/social";
import { activityStats } from "./lib/streak";
import { oppnaKonto, renderIdag, type CloudUi } from "./views/idag";
import { PassView } from "./views/pass";
import { LasView } from "./views/las";
import { renderOrdlista } from "./views/ordlista";
import { renderTopplista } from "./views/topplista";

// pass-skärmen finns kvar men har ingen flik — dit kommer man via Starta-knapparna
const TABS = [
  {
    id: "idag", label: "Idag",
    icon: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
    iconOn: '<svg class="icf" viewBox="0 0 24 24"><circle class="fl" cx="12" cy="12" r="4.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
  },
  {
    id: "ordlista", label: "Ordlista",
    icon: '<svg class="ico" viewBox="0 0 24 24"><path d="M5 4h13a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4z"/><path d="M5 4v14a2 2 0 0 0 2 2"/><path d="M10 9h6M10 13h4"/></svg>',
    iconOn: '<svg class="icf" viewBox="0 0 24 24"><path class="fl" d="M5 4h13a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4z"/><path d="M5 4v14a2 2 0 0 0 2 2"/></svg>',
  },
  {
    id: "topplista", label: "Topplista",
    icon: '<svg class="ico" viewBox="0 0 24 24"><path d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 20h8"/></svg>',
    iconOn: '<svg class="icf" viewBox="0 0 24 24"><path class="fl" d="M7 4h10v4a5 5 0 0 1-10 0V4z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 20h8"/></svg>',
  },
] as const;

type TabId = (typeof TABS)[number]["id"] | "pass" | "las";

async function boot(): Promise<void> {
  initViewportFit();
  const root = document.getElementById("app")!;
  root.innerHTML = `<div class="tomt" style="min-height:60dvh"><div class="stor">Glosa</div><p>Laddar ordbasen …</p></div>`;

  const store = new Store();
  try {
    await store.loadWords(import.meta.env.BASE_URL);
  } catch (e) {
    root.innerHTML = `<div class="tomt" style="min-height:60dvh">
      <div class="stor">Hoppsan</div>
      <p>Kunde inte ladda ordbasen. Kontrollera nätverket och ladda om sidan.</p>
      <p class="omtext">${String(e instanceof Error ? e.message : e)}</p></div>`;
    return;
  }
  store.loadUserData();
  requestPersistence();

  const sb = createSupabase();
  const sync = new CloudSync(store, sb);
  store.onDirty = (kind, key) => sync.markDirty(kind, key);
  store.snapshotToday();

  const cloud: CloudUi = {
    get email() { return sync.session?.user.email ?? null; },
    get status() { return sync.status; },
    get lastSyncAt() { return sync.lastSyncAt; },
    get lastError() { return sync.lastError; },
    async sendCode(email) {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: new URL(import.meta.env.BASE_URL, location.origin).href,
        },
      });
      if (error) throw new Error(error.message);
    },
    async verifyCode(email, value) {
      const parsed = parseLoginInput(value);
      if (!parsed) {
        throw new Error("Skriv koden ur mejlet — eller klistra in hela inloggningslänken.");
      }
      const { error } =
        parsed.kind === "link"
          ? await sb.auth.verifyOtp({
              token_hash: parsed.tokenHash,
              type: parsed.type as "magiclink",
            })
          : await sb.auth.verifyOtp({ email, token: parsed.code, type: "email" });
      if (error) throw new Error(error.message);
    },
    async signOut() {
      await sb.auth.signOut();
    },
  };

  root.innerHTML = `
    <div class="screen" id="screen-idag"></div>
    <div class="screen" id="screen-pass" hidden></div>
    <div class="screen" id="screen-las" hidden></div>
    <div class="screen" id="screen-ordlista" hidden></div>
    <div class="screen" id="screen-topplista" hidden></div>
    <nav class="tabbar" aria-label="Flikar">
      ${TABS.map(
        (t) => `<button type="button" data-tab="${t.id}">${t.icon}${t.iconOn}${t.label}</button>`
      ).join("")}
    </nav>`;

  const screens: Record<TabId, HTMLElement> = {
    idag: root.querySelector("#screen-idag")!,
    pass: root.querySelector("#screen-pass")!,
    las: root.querySelector("#screen-las")!,
    ordlista: root.querySelector("#screen-ordlista")!,
    topplista: root.querySelector("#screen-topplista")!,
  };
  const tabButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  let currentTab: TabId = "idag";

  function showTab(id: TabId): void {
    currentTab = id;
    root.classList.toggle("tab-pass", id === "pass" || id === "las");
    (Object.keys(screens) as TabId[]).forEach((k) => (screens[k].hidden = k !== id));
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (id === "idag") renderIdagTab();
    if (id === "ordlista") renderOrdlista(screens.ordlista, store, social);
    if (id === "topplista") void renderTopplista(screens.topplista, { social, uid: sync.session?.user.id ?? null });
    if (id === "pass") { pass.refreshIdle(); pass.focusInput(); }
  }

  function flashKonto(): void {
    // panelen bor i inställningsvyn — utan den blir felet helt osynligt
    // ("jag klickar och inget händer"), så fäll ut den först
    if (!document.getElementById("kontoPanel")) {
      oppnaKonto();
      showTab("idag");
    }
    const p = document.getElementById("kontoPanel");
    p?.scrollIntoView({ behavior: "smooth", block: "center" });
    p?.classList.add("pulse");
    window.setTimeout(() => p?.classList.remove("pulse"), 1500);
  }

  /** Öva — motorn bygger portionen: förfallet först, nya i mån av plats och budget. */
  function startPass(): void {
    // inlogg krävs för att öva — annars riskerar ett helt pass att aldrig sparas i molnet
    if (!sync.session) {
      showTab("idag");
      flashKonto();
      return;
    }
    // vänta in första synken — annars kan en andra enhet dubbla dagens nya ord
    if (sync.status === "syncing") return;
    // misslyckad synk = lokala datat kan vara fel version — öva inte ovanpå det
    if (sync.status === "error") { flashKonto(); return; }
    // en pausad övning fortsätts alltid först — inga nya ord förrän den är klar
    const paused = loadPass();
    if (paused && pass.resume(paused)) {
      showTab("pass");
      return;
    }
    const baseline = store.dueSoonCount(); // före introduktionen — prognosen räknar de nya
    const cards = store.startPortion();
    if (!cards.length) return;
    pass.start(cards, baseline);
    showTab("pass");
  }

  /** Läsförståelse — låses upp vid Turista, kräver inloggning (Edge Function). */
  function startLas(): void {
    if (!sync.session) {
      showTab("idag");
      flashKonto();
      return;
    }
    if (sync.status === "syncing") return;
    if (sync.status === "error") { flashKonto(); return; }
    showTab("las");
    void las.start();
  }

  const social = new Social(sb, () => sync.session?.user.id ?? null);

  /** Ladda upp mina topplistesiffror (streak, dagar, resapoäng). */
  function pushMyStats(): void {
    if (!sync.session) return;
    const a = activityStats(store.data.days);
    void social
      .pushStats({ streak: a.streak, totalDays: a.totalDays, score: store.stats().score })
      .catch(() => { /* topplistan är grädde — aldrig blockera */ });
  }

  const pass = new PassView(
    screens.pass,
    store,
    () => { pushMyStats(); showTab("idag"); },
    () => startPass(),
    () => sync.session !== null,
    () => sync.status === "syncing",
    social
  );
  pass.render();

  const las = new LasView(screens.las, store, sb, () => { pushMyStats(); showTab("idag"); });

  function renderIdagTab(): void {
    renderIdag(screens.idag, store, { startPass, startLas }, cloud);
  }

  sync.onStatus = () => {
    if (currentTab === "idag") renderIdagTab();
    // passets omrendering togglar pass-live (tabbaren) utifrån SITT läge —
    // får bara ske när passfliken faktiskt visas, annars flimrar navet i läsvyn
    if (currentTab === "pass") pass.refreshIdle();
  };

  let syncedUser = "";
  sb.auth.onAuthStateChange((event, session) => {
    // kör initialSync vid ny användare — och FÖRSÖK IGEN om förra misslyckades
    // (utgången token vid appstart gav 401 mitt i pull; nästa TOKEN_REFRESHED läker det)
    if (session && (syncedUser !== session.user.id || sync.status === "error")) {
      syncedUser = session.user.id;
      void sync.initialSync(session).then(async () => {
        // efter misslyckad synk är lokala datat inte molnets — pusha aldrig
        // topplistesiffror då (en tom enhet skulle nollställa poängen publikt)
        if (sync.status === "error") return;
        try {
          await social.ensureProfile(session.user.email);
        } catch { /* migration 0002 kanske inte körd än — topplistan förklarar */ }
        pushMyStats();
        if (currentTab === "idag") renderIdagTab();
        if (currentTab === "topplista") void renderTopplista(screens.topplista, { social, uid: session.user.id });
      });
    }
    if (event === "SIGNED_OUT") {
      syncedUser = "";
      sync.signedOut();
    }
    if (currentTab === "idag") renderIdagTab();
    if (currentTab === "pass") pass.refreshIdle();
  });

  // tryck på fliken du redan står på = hoppa till toppen (iOS statusbar-tap
  // når aldrig .screen-scrollern, så appen har sitt eget sätt)
  tabButtons.forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.tab as TabId;
    if (id === currentTab) screens[id].scrollTo({ top: 0, behavior: "smooth" });
    else showTab(id);
  }));
  showTab("idag");

  // debug-handtag för felsökning i konsolen (och smoke-tester)
  (window as unknown as Record<string, unknown>).__glosa = { store, sync };

  // uppdatera Idag-statistiken när appen får fokus igen (t.ex. ny dag),
  // och skicka upp osynkade ändringar när den läggs i bakgrunden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sync.flush();
    else if (currentTab === "idag") renderIdagTab();
  });
}

void boot();
