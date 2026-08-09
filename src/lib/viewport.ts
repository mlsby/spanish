/**
 * iOS Safari krymper inte layouten när tangentbordet öppnas
 * (interactive-widget=resizes-content stöds bara på Android/Chrome) —
 * tangentbordet lägger sig ovanpå sidan och Safari panorerar. Därför mäter
 * vi den faktiskt synliga ytan med VisualViewport-API:et och låser appens
 * höjd till den via --vvh. Då hamnar svarsraden alltid precis ovanför
 * tangentbordet och hela passvyn får plats på skärmen.
 */
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
    // kompaktläge när tangentbordet (eller ett litet fönster) äter höjden
    root.classList.toggle("kbd", vv.height < 620);
    // motverka Safaris egen panorering så att appen ligger stilla i toppen
    if (vv.offsetTop > 0 || window.scrollY > 0) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  window.addEventListener("orientationchange", () => window.setTimeout(apply, 300));
  apply();
}
