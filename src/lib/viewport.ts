/**
 * iOS Safari krymper inte layouten när tangentbordet öppnas
 * (interactive-widget=resizes-content stöds bara på Android/Chrome) —
 * tangentbordet lägger sig ovanpå sidan och Safari panorerar. Därför mäter
 * vi den faktiskt synliga ytan med VisualViewport-API:et och låser appens
 * höjd till den via --vvh. Då hamnar svarsraden alltid precis ovanför
 * tangentbordet och hela passvyn får plats på skärmen.
 */
/** Under en övning hålls kompaktläget kvar när tangentbordet väl varit uppe. */
let hold = false;
let sticky = false;
let reapply: () => void = () => {};

/**
 * Övningen slår på/av "håll kompakt": stängs tangentbordet mitt i ett pass ska
 * kortet inte växa (större text och luft) — det behåller sin storlek tills passet slutar.
 */
export function setCompactHold(on: boolean): void {
  if (hold === on) return;
  hold = on;
  if (!on) sticky = false;
  reapply();
}

export function initViewportFit(): void {
  const root = document.documentElement;
  const vv = window.visualViewport;

  if (!vv) {
    // gammal webbläsare utan API:et — falla tillbaka på media query-beteende
    const mq = window.matchMedia("(max-height: 620px)");
    const apply = () => root.classList.toggle("kbd", mq.matches);
    mq.addEventListener?.("change", apply);
    apply();
    return;
  }

  const apply = () => {
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    // kompaktläge när tangentbordet (eller ett litet fönster) äter höjden —
    // under en övning ligger det kvar även om tangentbordet fälls ihop
    const kompakt = vv.height < 620;
    if (kompakt && hold) sticky = true;
    root.classList.toggle("kbd", kompakt || (hold && sticky));
    // motverka Safaris egen panorering så att appen ligger stilla i toppen
    if (vv.offsetTop > 0 || window.scrollY > 0) window.scrollTo(0, 0);
  };
  reapply = apply;
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("orientationchange", () => window.setTimeout(apply, 300));
  apply();
}
