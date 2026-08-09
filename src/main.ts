import "./styles.css";
import { Store } from "./lib/store";
import { requestPersistence } from "./lib/storage";
import { renderIdag } from "./views/idag";
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
  store.snapshotToday();

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
    (Object.keys(screens) as TabId[]).forEach((k) => (screens[k].hidden = k !== id));
    tabButtons.forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (id === "idag") renderIdagTab();
    if (id === "ordlista") renderOrdlista(screens.ordlista, store);
    if (id === "pass") pass.focusInput();
  }

  function startPass(includeNew: boolean): void {
    if (includeNew) store.introduceToday();
    const cards = store.dueCards();
    pass.start(cards);
    showTab("pass");
  }

  const pass = new PassView(
    screens.pass,
    store,
    () => showTab("idag"),
    (includeNew) => startPass(includeNew)
  );
  pass.render();

  function renderIdagTab(): void {
    renderIdag(screens.idag, store, { startPass });
  }

  tabButtons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab as TabId)));
  showTab("idag");

  // uppdatera Idag-statistiken när appen får fokus igen (t.ex. ny dag)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentTab === "idag") renderIdagTab();
  });
}

void boot();
