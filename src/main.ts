import "./styles.css";
import { Store } from "./lib/store";
import { initViewportFit } from "./lib/viewport";
import { requestPersistence } from "./lib/storage";
import { createSupabase } from "./lib/supabase";
import { parseLoginInput } from "./lib/logintoken";
import { CloudSync } from "./lib/sync";
import { renderIdag, type CloudUi } from "./views/idag";
import { PassView } from "./views/pass";
import { renderOrdlista } from "./views/ordlista";

const TABS = [
  {
    id: "idag", label: "Idag",
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>',
  },
  {
    id: "pass", label: "Pass",
    icon: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1L19.5 7.5a2.1 2.1 0 0 0-3-3L5 16l-1 4z"/><path d="M13.5 6.5l3 3"/></svg>',
  },
  {
    id: "ordlista", label: "Ordlista",
    icon: '<svg viewBox="0 0 24 24"><path d="M5 4h13a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4z"/><path d="M5 4v14a2 2 0 0 0 2 2"/><path d="M10 9h6M10 13h4"/></svg>',
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

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
    <div class="screen" id="screen-ordlista" hidden></div>
    <nav class="tabbar" aria-label="Flikar">
      ${TABS.map(
        (t) => `<button type="button" data-tab="${t.id}">${t.icon}${t.label}</button>`
      ).join("")}
    </nav>`;

  const screens: Record<TabId, HTMLElement> = {
    idag: root.querySelector("#screen-idag")!,
    pass: root.querySelector("#screen-pass")!,
    ordlista: root.querySelector("#screen-ordlista")!,
  };
  const tabButtons = [...root.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  let currentTab: TabId = "idag";

  function showTab(id: TabId): void {
    currentTab = id;
    root.classList.toggle("tab-pass", id === "pass");
    (Object.keys(screens) as TabId[]).forEach((k) => (screens[k].hidden = k !== id));
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (id === "idag") renderIdagTab();
    if (id === "ordlista") renderOrdlista(screens.ordlista, store);
    if (id === "pass") { pass.refreshIdle(); pass.focusInput(); }
  }

  function flashKonto(): void {
    const p = document.getElementById("kontoPanel");
    p?.scrollIntoView({ behavior: "smooth", block: "center" });
    p?.classList.add("pulse");
    window.setTimeout(() => p?.classList.remove("pulse"), 1500);
  }

  function startPass(includeNew: boolean): void {
    // inlogg krävs för att öva — annars riskerar ett helt pass att aldrig sparas i molnet
    if (!sync.session) {
      showTab("idag");
      flashKonto();
      return;
    }
    if (includeNew) store.introduceToday();
    const cards = store.dueCards();
    pass.start(cards);
    showTab("pass");
  }

  const pass = new PassView(
    screens.pass,
    store,
    () => showTab("idag"),
    (includeNew) => startPass(includeNew),
    () => sync.session !== null
  );
  pass.render();

  function renderIdagTab(): void {
    renderIdag(screens.idag, store, { startPass }, cloud);
  }

  sync.onStatus = () => {
    if (currentTab === "idag") renderIdagTab();
  };

  let syncedUser = "";
  sb.auth.onAuthStateChange((event, session) => {
    if (session && syncedUser !== session.user.id) {
      syncedUser = session.user.id;
      void sync.initialSync(session).then(() => {
        if (currentTab === "idag") renderIdagTab();
      });
    }
    if (event === "SIGNED_OUT") {
      syncedUser = "";
      sync.signedOut();
    }
    if (currentTab === "idag") renderIdagTab();
    pass.refreshIdle();
  });

  tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab as TabId)));
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
