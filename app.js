/* ============================================================
   Casal d'hoquei — inscripcions (frontend)
   Formulari generat des de la config (Google Sheet).
   Per ara: un sol casal (estiu). Adjuntar fitxers + prefill local.
   ============================================================ */

// 🔧 Enganxa aquí la URL del teu Apps Script (acaba en /exec).
// Buida = MODE DEMO amb dades d'exemple.
// Si la pestanya Ajustes del full té la clau SCRIPT_URL, s'actualitzarà automàticament.
let SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwd6DenkPJ3ut5-lIiVKq4nr3TeMC6kHu8cX_iaZIYESYHXy_rgbPL2bw_Avwk5Kxfjtw/exec";

// 🔧 Quin formulari es mostra. Es llegeix de la URL: ...index.html?form=primavera
// Buit = formulari per defecte (les files del full sense columna "form").
const FORM_ID = (new URLSearchParams(location.search).get("form") || "").trim();

const CONTACT_PHONE = "+34629912840";
const STORAGE_KEY = "casal_hoquei_v1";
const DRAFT_KEY = "casal_hoquei_draft_v1";
const RETURNING_DISMISSED_KEY = "casal_hoquei_returning_dismissed";
const MAX_FILE_MB = 5;
const MAX_TOTAL_MB = 12;

const LOAD_HINTS = [
  "📋 Preparant la teva inscripció",
  "🏑 Buscant la millor línia de passada",
  "🛼 Fent els últims ajustos als patins",
  "✨ Donant els últims retocs",
];
let _hintTimer = null;
function startHintCycle() {
  const el = document.getElementById("load-hint");
  if (!el) return;
  const DOTS = [" .", " ..", " ..."];
  let phraseIdx = 0, dotsIdx = 0;
  const render = () => { el.textContent = LOAD_HINTS[phraseIdx] + DOTS[dotsIdx]; };
  render();
  _hintTimer = setInterval(() => {
    dotsIdx++;
    if (dotsIdx >= DOTS.length) {
      dotsIdx = 0;
      phraseIdx = (phraseIdx + 1) % LOAD_HINTS.length;
    }
    render();
  }, 600);
}
function stopHintCycle() {
  clearInterval(_hintTimer);
  _hintTimer = null;
}

// Textos llargs de les autoritzacions
const T_ACTIVITAT = "Autoritzo el meu fill/a a dur a terme les activitats programades al casal (esport, sortides, piscina, etc.), que es realitzaran del 29 de juny al 31 de juliol de 2026, tant a peu com en vehicle privat o públic. La responsabilitat de custòdia del club sobre l'infant serà exclusivament dins l'horari del casal, i passarà als tutors un cop finalitzada l'activitat.";
const T_VEHICLE = "Autoritzo a usar un vehicle privat per al desplaçament no urgent ni especialitzat en cas de necessitar atenció mèdica. També autoritzo a efectuar petites cures per part de l'equip de monitors.";
const T_IMATGE = "Autoritzo que la imatge del meu fill/a pugui aparèixer en fotografies i filmacions d'activitats del club, publicades a les pàgines oficials del club E7 i CP Riudebitlles i a Instagram, Twitter i Facebook, amb finalitats esportives i promocionals.";
const T_LOPD = "D'acord amb la normativa de protecció de dades, t'informem que les dades facilitades es tractaran amb la confidencialitat adequada, s'incorporaran a un fitxer del Club Esportiu E7 i només s'utilitzaran per a la gestió del casal. Pots exercir els drets d'accés, rectificació i cancel·lació adreçant-te al club per escrit.";

// ---- Config d'exemple (mode demo) ----
const DEMO_CONFIG = {
  settings: {
    nombre_campus: "Campus Hoquei Riudebitlles",
    club: "El plaer de jugar!",
    temporada: "2026",
    lema: "Inscripcions obertes",
    hero_titulo: "Campus d'Hoquei Riudebitlles",
    intro: "Del 29 de juny al 31 de juliol. Completa la inscripció, tria les setmanes i adjunta la targeta sanitària.",
    email_contacto: "coordinaciocpriudebitlles@gmail.com",
    email_asunto: "Inscripció rebuda · Casal Hoquei Estiu 2026",
    email_intro: "Hem rebut la inscripció. Aquí tens el resum:",
    texto_boton: "Enviar inscripció",
    mensaje_exito: "T'hem enviat un correu amb el resum. Si has de fer algun canvi, escriu-nos.",
    consentimiento: "He llegit i accepto la política de protecció de dades del Club Esportiu E7.",
    semanas_obligatorias: true
  },
  campuses: [],  // un sol casal de moment; els campus s'implementaran després
  weeks: [
    { id: "S1", etiqueta: "Setmana 1", fechas: "29 juny – 3 juliol" },
    { id: "S2", etiqueta: "Setmana 2", fechas: "6 – 10 juliol" },
    { id: "S3", etiqueta: "Setmana 3", fechas: "13 – 17 juliol", plazas: 0, plazas_restantes: 0 },
    { id: "S4", etiqueta: "Setmana 4", fechas: "20 – 24 juliol" },
    { id: "S5", etiqueta: "Setmana 5", fechas: "27 – 31 juliol" }
  ],
  fields: [
    // Dades del jugador/a
    { id: "nom_jugador", etiqueta: "Nom i cognoms", tipo: "text", obligatorio: true, grupo: "Dades del jugador/a", orden: 1 },
    { id: "data_naixement", etiqueta: "Data de naixement", tipo: "date", obligatorio: true, ayuda: "Exemple: 18/11/2018", grupo: "Dades del jugador/a", orden: 2 },
    { id: "sap_nedar", etiqueta: "Sap nedar?", tipo: "radio", opciones: "Sí|No", obligatorio: true, grupo: "Dades del jugador/a", orden: 3 },
    // Dades del pare/mare/tutor
    { id: "nom_tutor", etiqueta: "Nom i cognoms del tutor/a", tipo: "text", obligatorio: true, grupo: "Dades del pare/mare/tutor", orden: 4 },
    { id: "nif", etiqueta: "NIF", tipo: "text", obligatorio: true, grupo: "Dades del pare/mare/tutor", orden: 5 },
    { id: "adreca", etiqueta: "Adreça", tipo: "text", obligatorio: true, grupo: "Dades del pare/mare/tutor", orden: 6 },
    { id: "poblacio", etiqueta: "Població", tipo: "text", obligatorio: true, grupo: "Dades del pare/mare/tutor", orden: 7 },
    { id: "codi_postal", etiqueta: "Codi postal", tipo: "text", obligatorio: true, grupo: "Dades del pare/mare/tutor", orden: 8 },
    { id: "telefon", etiqueta: "Telèfon", tipo: "tel", obligatorio: true, grupo: "Dades del pare/mare/tutor", orden: 9 },
    { id: "email", etiqueta: "Email", tipo: "email", obligatorio: true, ayuda: "Hi enviarem la confirmació.", grupo: "Dades del pare/mare/tutor", orden: 10 },
    // Autoritzacions
    { id: "aut_activitat", etiqueta: "Autorització de l'activitat", tipo: "radio", opciones: "Sí|No", obligatorio: true, ayuda: T_ACTIVITAT, grupo: "Autoritzacions", orden: 11 },
    { id: "aut_vehicle", etiqueta: "Autorització de vehicle i cures", tipo: "radio", opciones: "Sí|No", obligatorio: true, ayuda: T_VEHICLE, grupo: "Autoritzacions", orden: 12 },
    { id: "drets_imatge", etiqueta: "Drets d'imatge", tipo: "radio", opciones: "Sí|No", obligatorio: true, ayuda: T_IMATGE, grupo: "Autoritzacions", orden: 13 },
    // Documentació
    { id: "targeta_sanitaria", etiqueta: "Còpia de la targeta sanitària", tipo: "file", opciones: "image/*,application/pdf", obligatorio: false, ayuda: "Foto o PDF. Si ja l'has enviat altres anys, pots saltar aquest pas o enviar-la a coordinaciocpriudebitlles@gmail.com.", grupo: "Documentació", orden: 14 },
    // Protecció de dades
    { id: "nota_lopd", etiqueta: "Protecció de dades", tipo: "nota", ayuda: T_LOPD, grupo: "Protecció de dades", orden: 15 }
  ],
  form:  { id: "estiu", nombre: "Casal d'Estiu 2026",      habilitado: true, estacio: "estiu" },
  forms: [
    { id: "estiu",     nombre: "Casal d'Estiu 2026",        habilitado: true, estacio: "estiu" },
    { id: "primavera", nombre: "Casal de Primavera 2027",   habilitado: true, estacio: "primavera" },
    { id: "hivern",    nombre: "Casal de Nadal 2026",       habilitado: true, estacio: "hivern" }
  ]
};

// ---- Estat ----
let CONFIG = null;
let currentCampus = null;
let activeFormId = FORM_ID;     // pot canviar quan l'usuari alterna formularis al hero
let allForms = [];              // llista de formularis disponibles (del config)
let currentFormIdx = 0;         // índex actiu al slider del hero
let heroTouchStartX = 0;        // per al swipe tàctil
let childCount = 1;            // quants jugadors/es s'estan inscrivint alhora
let returningDismissed = false; // l'usuari ha tancat la barra "ja t'havíem vist"
let recoverAvailable = false;   // hi ha dades desades per recuperar (controla la icona de la nav)
let wizardSteps = [];          // llista de .section del wizard (buit = sense wizard)
let wizardStep  = 0;           // índex del pas actual
let draftSaveTimer = null;
const fileStore = {};
const els = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  document.body.classList.add("page--loading");
  cache();
  hideReturning();
  returningDismissed = loadReturningDismissed();
  els.retry.addEventListener("click", load);
  els.form.addEventListener("submit", onSubmit);
  // En marcar el consentiment, treu el resaltat d'error que hi pugui haver.
  const consentInput = document.getElementById("consent");
  if (consentInput) consentInput.addEventListener("change", () => {
    if (consentInput.checked) consentInput.closest(".consent")?.classList.remove("consent--invalid");
  });
  els.form.addEventListener("input", () => { scheduleDraftSave(); scheduleUiUpdate(); });
  els.form.addEventListener("change", () => { scheduleDraftSave(); scheduleUiUpdate(); });
  els.another.addEventListener("click", resetForNew);
  els.returningClose.addEventListener("click", dismissReturning);
  if (els.returningToggle) els.returningToggle.addEventListener("click", toggleReturning);
  if (els.printBtn) els.printBtn.addEventListener("click", () => window.print());
  setupIOSBarFix();
  await load();
}

// iOS Safari minimitza la seva barra inferior en fer scroll i reserva la franja del fons
// de la pantalla per fer-la reaparèixer: el primer toc als nostres botons hi "desperta" la
// barra del Safari en comptes de clicar. Detectem aquest estat (l'àrea visible creix quan
// la barra del Safari desapareix) i, via la classe a <body>, pugem els botons per sobre
// d'aquesta zona. Quan la barra del Safari torna, ja aixeca la nostra i reduïm el padding.
// Només té efecte visual a iOS (el CSS està darrere d'un @supports).
function setupIOSBarFix() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  // Alçada visible inicial = estat amb la barra del navegador PRESENT (a la càrrega sempre hi és).
  // La fem servir de referència en comptes d'assumir res: així mai marquem "amagada" de més.
  let baseH = null;
  const update = () => {
    const visible = vv ? vv.height : window.innerHeight;
    if (baseH === null) baseH = visible;
    // El creixement de l'àrea visible respecte de l'inicial = alçada REAL de la barra del
    // navegador que s'ha amagat. El teclat la fa més petita → creixement negatiu → mai amagada.
    const grew = visible - baseH;
    const toolbarHidden = grew > 30;
    if (toolbarHidden) {
      // Elevem els botons exactament l'alçada mesurada de la barra del navegador. Així s'adapta
      // sol a cada navegador (Safari, Chrome…) en comptes d'un valor fix calibrat per a un de sol.
      // Acotat a un rang raonable per si un navegador retorna una mesura estranya.
      const lift = Math.min(72, Math.max(30, Math.round(grew)));
      root.style.setProperty("--bar-lift", lift + "px");
    }
    document.body.classList.toggle("ios-toolbar-hidden", toolbarHidden);
  };
  if (vv) {
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
  }
  // En girar el dispositiu, les alçades canvien: re-establim la referència.
  window.addEventListener("orientationchange", () => { baseH = null; update(); });
  update();
}

function cache() {
  const id = (x) => document.getElementById(x);
  ["loading","load-error","load-error-hint","closed","retry","form","form-sections",
   "submit-btn","submit-note","done","done-text","done-summary","another",
   "returning","returning-text","returning-actions","returning-close","returning-toggle","consent-text","print-btn"]
    .forEach((k) => (els[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = id(k)));
  els.sections = id("form-sections");
}

// ---- Helpers ----
function revealHero() {
  document.body.classList.remove("page--loading");
  requestAnimationFrame(function() {
    var hero = document.getElementById("hero");
    if (hero) hero.classList.remove("hero--init");
  });
}

// ---- Skeleton de càrrega ----
function renderSkeleton() {
  const prev = document.getElementById("form-skeleton");
  if (prev) prev.remove();
  const sk = document.createElement("div");
  sk.id = "form-skeleton";
  sk.className = "form-skeleton";
  [[4, true], [5, true], [3, false]].forEach(([n, inputs]) => {
    const card = document.createElement("div"); card.className = "skeleton-card";
    const fields = Array.from({ length: n }, (_, i) => inputs
      ? `<div class="skeleton-field"><span class="skeleton-line skeleton-label"></span><span class="skeleton-line skeleton-input"></span></div>`
      : `<div class="skeleton-field"><span class="skeleton-line skeleton-label" style="width:${[60,45,72,55][i]}%"></span></div>`
    ).join("");
    card.innerHTML = `<div class="skeleton-head"><span class="skeleton-line skeleton-num"></span><span class="skeleton-line skeleton-title"></span></div>${fields}`;
    sk.appendChild(card);
  });
  els.loading.appendChild(sk);
}

// ---- Càrrega ----
async function load() {
  document.body.classList.remove("page--no-forms");
  els.loading.hidden = false; els.loadError.hidden = true; els.closed.hidden = true;
  els.form.hidden = true; els.done.hidden = true;
  hideReturning();
  startHintCycle();
  try {
    CONFIG = await fetchConfig();
    if (CONFIG.settings && CONFIG.settings.SCRIPT_URL) SCRIPT_URL = CONFIG.settings.SCRIPT_URL.trim();
    applySettings(CONFIG.settings || {});
    initHeroSlider();
    if (CONFIG.form && CONFIG.form.habilitado === false) {
      document.body.classList.add("page--no-forms");
      stopHintCycle(); els.loading.hidden = true; els.closed.hidden = false;
      revealHero(); return;
    }
    const open = enabledCampuses();
    if (CONFIG.campuses && CONFIG.campuses.length && open.length === 0) {
      document.body.classList.add("page--no-forms");
      stopHintCycle(); els.loading.hidden = true; els.closed.hidden = false;
      revealHero(); return;
    }
    currentCampus = open.length ? open[0].id : null;
    renderForm();
    stopHintCycle(); els.loading.hidden = true; els.form.hidden = false;
    revealHero();
    updateProgress();
    updateAllPrices();
    maybeShowReturning();
  } catch (err) {
    console.error(err);
    stopHintCycle(); els.loading.hidden = true; els.loadError.hidden = false;
    revealHero();
    if (!SCRIPT_URL) els.loadErrorHint.textContent = "Encara no has configurat la URL del servidor (SCRIPT_URL a app.js).";
  }
}

async function fetchConfig() {
  if (!SCRIPT_URL) return structuredClone(DEMO_CONFIG);
  const res = await fetch(`${SCRIPT_URL}?action=config&form=${encodeURIComponent(activeFormId)}`, { method: "GET" });
  if (!res.ok) throw new Error("config HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}
function enabledCampuses() { return (CONFIG.campuses || []).filter((c) => c.habilitado !== false); }

// ---- Settings ----
function applySettings(s) {
  const setText = (sel, val) => document.querySelectorAll(sel).forEach((n) => { if (val != null) n.textContent = val; });
  setText("[data-camp-name]", s.nombre_campus);
  setText("[data-club]", s.club);
  setText("[data-season]", s.temporada);
  setText("[data-tagline]", s.lema);
  setText("[data-hero-title]", s.hero_titulo || (CONFIG && CONFIG.form && CONFIG.form.nombre));
  setText("[data-intro]", s.intro);
  setText("[data-submit-text]", s.texto_boton);
  if (s.consentimiento) els.consentText.textContent = s.consentimiento;
  if (s.nombre_campus) {
    document.title = `Inscripcions · ${s.nombre_campus}`;
    const ogTitle = document.getElementById("og-title");
    if (ogTitle) ogTitle.setAttribute("content", `Inscripcions · ${s.nombre_campus}`);
  }
  if (s.intro) {
    const ogDesc = document.getElementById("og-desc");
    if (ogDesc) ogDesc.setAttribute("content", s.intro);
  }
  const link = document.querySelector("[data-contact-link]");
  if (link) {
    link.href = `tel:${CONTACT_PHONE}`;
    link.setAttribute("aria-label", "Trucar al 629 912 840");
  }
  applyFooterContact(s);
}

// Omple les dades de contacte al footer
function applyFooterContact(s) {
  const footContact = document.getElementById("foot-contact");
  const footPhone = document.getElementById("foot-phone");
  const footEmail = document.getElementById("foot-email");
  let hasAny = false;
  if (footPhone && CONTACT_PHONE) {
    const display = CONTACT_PHONE.replace(/^\+34/, "").replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
    footPhone.href = `tel:${CONTACT_PHONE}`; footPhone.textContent = `Tel. ${display}`;
    hasAny = true;
  }
  if (footContact && CONTACT_PHONE) {
    let waLink = document.getElementById("foot-whatsapp");
    if (!waLink) {
      waLink = document.createElement("a");
      waLink.id = "foot-whatsapp";
      waLink.className = "foot__contact-item";
      waLink.target = "_blank"; waLink.rel = "noopener noreferrer";
      footContact.appendChild(waLink);
    }
    waLink.href = `https://wa.me/${CONTACT_PHONE.replace(/\D/g, "")}`;
    waLink.textContent = "WhatsApp";
    hasAny = true;
  }
  if (footEmail && s.email_contacto) {
    footEmail.href = `mailto:${s.email_contacto}`; footEmail.textContent = s.email_contacto;
    footEmail.hidden = false; hasAny = true;
  } else if (footEmail) { footEmail.hidden = true; }
  if (footContact) footContact.hidden = !hasAny;
}

// ---- Hero Slider ----
function initHeroSlider() {
  const forms = (CONFIG.forms || []).filter(function(f) { return f.habilitado !== false && f.id; });
  allForms = forms;

  const curId = (CONFIG.form && CONFIG.form.id) || activeFormId;
  currentFormIdx = Math.max(0, forms.findIndex(function(f) { return f.id === curId; }));

  const estacio = (CONFIG.form && CONFIG.form.estacio)
    || (forms[currentFormIdx] && forms[currentFormIdx].estacio)
    || inferSeason(curId);
  applyHeroTheme(estacio);

  const hero = document.getElementById("hero");
  const nav  = document.getElementById("hero-nav");

  if (!hero || !nav) return;

  if (forms.length < 2) {
    nav.hidden = true;
    hero.classList.remove("has-slider");
    return;
  }
  nav.hidden = false;
  hero.classList.add("has-slider");

  // Pills amb el nom de cada formulari
  const SEASON_ICONS = { estiu: "☀", hivern: "❄", primavera: "🌿", tardor: "⚡️" };
  nav.innerHTML = "";
  forms.forEach(function(f, i) {
    const season = f.estacio || inferSeason(f.id);
    const icon = SEASON_ICONS[season] || "";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "hero-pill" + (i === currentFormIdx ? " is-active" : "");
    pill.innerHTML = (icon ? "<span class=\"hero-pill__icon\" aria-hidden=\"true\">" + icon + "</span>" : "")
      + "<span>" + escapeHtml(f.nombre || f.id) + "</span>";
    pill.setAttribute("aria-pressed", String(i === currentFormIdx));
    pill.addEventListener("click", function() {
      // Si l'usuari ha lliscat per fer scroll dels pills, no ho considerem un clic
      if (nav._dragged) return;
      switchHeroForm(i);
    });
    nav.appendChild(pill);
  });

  // Detecció de drag dins de la barra de pills: distingeix scroll horitzontal d'un clic (init once)
  if (!nav.dataset.dragInit) {
    nav.dataset.dragInit = "1";
    let startX = 0, startY = 0;
    nav.addEventListener("touchstart", function(e) {
      nav._dragged = false;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, { passive: true });
    nav.addEventListener("touchmove", function(e) {
      if (Math.abs(e.touches[0].clientX - startX) > 8 || Math.abs(e.touches[0].clientY - startY) > 8) {
        nav._dragged = true;
      }
    }, { passive: true });
    // Anul·la el clic sintètic que el navegador dispara just després d'un drag
    nav.addEventListener("click", function(e) {
      if (nav._dragged) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  // Swipe tàctil del hero per canviar de formulari (init once)
  if (!hero.dataset.swipeInit) {
    hero.dataset.swipeInit = "1";
    let startY = 0;
    hero.addEventListener("touchstart", function(e) {
      // Si el toc comença dins de la barra de pills, és per fer-hi scroll: ignorem el swipe del hero
      if (e.target.closest("#hero-nav")) { heroTouchStartX = null; return; }
      heroTouchStartX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });
    hero.addEventListener("touchend", function(e) {
      if (heroTouchStartX == null) return;
      const dx = e.changedTouches[0].clientX - heroTouchStartX;
      const dy = e.changedTouches[0].clientY - startY;
      // Només swipe clarament horitzontal (un scroll vertical no ha de canviar de formulari)
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      switchHeroForm(dx < 0
        ? (currentFormIdx + 1) % allForms.length
        : (currentFormIdx - 1 + allForms.length) % allForms.length);
    }, { passive: true });
  }
}

function inferSeason(formId) {
  const id = String(formId || "").toLowerCase();
  if (/estiu|verano|summer/.test(id))       return "estiu";
  if (/hivern|invierno|winter|nadal/.test(id)) return "hivern";
  if (/primavera|spring/.test(id))           return "primavera";
  if (/tardor|otono|autumn|fall/.test(id))   return "tardor";
  return "estiu"; // per defecte
}

function applyHeroTheme(estacio) {
  const hero = document.getElementById("hero");
  if (!hero) return;
  ["estiu", "hivern", "primavera", "tardor"].forEach(function(s) { hero.classList.remove("season-" + s); });
  const s = String(estacio || "").toLowerCase().trim();
  if (s) hero.classList.add("season-" + s);
}

async function switchHeroForm(idx) {
  if (idx === currentFormIdx || !allForms[idx]) return;
  currentFormIdx = idx;
  activeFormId = allForms[idx].id;

  const hero = document.getElementById("hero");
  if (hero) hero.classList.add("hero--init");

  await load();
}

// ---- Render ----
function renderForm() {
  // Si el bloc de consentiment estava dins de les seccions (re-render), el recuperem primer
  const consentEl = document.querySelector(".consent");
  if (consentEl && consentEl.closest("#form-sections")) {
    document.getElementById("price-total-card").insertAdjacentElement("beforebegin", consentEl);
  }

  els.sections.innerHTML = "";
  childCount = Math.max(1, childCount || 1);
  let n = 0;
  const open = enabledCampuses();
  if (open.length > 1) { n++; els.sections.appendChild(sectionEl(n, "Tria el casal", [campusPickerEl(open)])); }

  const allFields = [...(CONFIG.fields || [])].sort((a, b) => (a.orden || 0) - (b.orden || 0));
  const fileFields = allFields.filter((f) => f.tipo === "file");
  const nonFileFields = allFields.filter((f) => f.tipo !== "file");

  const groups = []; const byName = {};
  for (const f of nonFileFields) {
    const g = f.grupo || "Inscripció";
    if (!byName[g]) { byName[g] = { name: g, fields: [] }; groups.push(byName[g]); }
    byName[g].fields.push(f);
  }
  const childGroup = detectChildGroup(groups);
  for (const g of groups) {
    if (g.name === childGroup) { n++; els.sections.appendChild(childrenSectionEl(n, g, fileFields)); }
    else if (g.fields.length) { n++; els.sections.appendChild(sectionEl(n, g.name, g.fields.map((f) => fieldEl(f)))); }
  }

  // Mou el consentiment dins de l'última secció (Protecció de dades)
  const lastSection = els.sections.querySelector(".section:last-child");
  if (lastSection && consentEl) lastSection.appendChild(consentEl);

  initWizard();
}

// ---- Wizard de passos ----
function initWizard() {
  // Elimina wizard anterior (re-render)
  const oldNav = document.getElementById("wizard-nav");
  if (oldNav) oldNav.remove();
  document.body.classList.remove("has-wizard");

  // Restaura visibilitat per defecte
  const priceCard  = document.getElementById("price-total-card");
  const submitRow  = els.form.querySelector(".submit-row");
  if (priceCard) priceCard.hidden = false;
  if (submitRow) submitRow.hidden = false;
  // (res a netejar — el padding ja no s'aplica)

  wizardSteps = [...els.sections.querySelectorAll(".section")];
  wizardStep  = 0;

  // Al PC (pointer: fine) mostrem el formulari complet sense wizard
  if (!window.matchMedia("(pointer: coarse)").matches) {
    wizardSteps = [];
    // Assegura que totes les seccions siguin visibles
    els.sections.querySelectorAll(".section").forEach((s) => { s.hidden = false; });
    return;
  }

  if (wizardSteps.length <= 1) { wizardSteps = []; return; }

  // Amaga el botó d'enviament original; en creem un al wizard nav
  if (submitRow) submitRow.hidden = true;

  // scroll-padding-bottom al CSS fa que scrollIntoView respecti la barra sense afegir espai visual

  // Barra de navegació inferior (sticky)
  const nav = document.createElement("div");
  nav.id = "wizard-nav";
  nav.className = "wizard-nav";
  const submitLabel = (CONFIG && CONFIG.settings && CONFIG.settings.texto_boton)
    || (els.submitBtn && els.submitBtn.querySelector(".btn__label") && els.submitBtn.querySelector(".btn__label").textContent)
    || "Enviar inscripció";
  const PEOPLE_SVG =
    `<svg class="wc__people" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
      `<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>` +
    `</svg>`;
  const CHEVRON_UP =
    `<svg class="wc__chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<polyline points="18 15 12 9 6 15"/>` +
    `</svg>`;
  const CHEV_LEFT =
    `<svg class="wz-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
  const CHEV_RIGHT =
    `<svg class="wz-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
  const HIST_SVG =
    `<span class="wizard-nav__recover-icon"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg></span>`;
  nav.innerHTML =
    // Popup de fills (s'obre cap amunt)
    `<div class="wizard-children-popup" id="wizard-children-popup" hidden>` +
      `<div class="wcp__list" id="wcp-list"></div>` +
    `</div>` +
    // Popup de recuperació de dades (s'obre cap amunt)
    `<div class="wizard-children-popup wizard-recover-popup" id="wizard-recover-popup" hidden>` +
      `<p class="wcp__title">Recupera dades d'una inscripció anterior</p>` +
      `<div id="wizard-recover-list"></div>` +
    `</div>` +
    `<div class="wizard-nav__row">` +
      `<div class="wizard-nav__left">` +
        `<button type="button" class="btn btn--ghost wizard-nav__back" id="wizard-back">` + CHEV_LEFT + `<span>Enrere</span></button>` +
        `<button type="button" class="wizard-nav__recover" id="wizard-recover" hidden aria-label="Recupera dades d'una inscripció anterior">` +
          HIST_SVG +
          `<span class="wizard-nav__recover-text">Historial</span>` +
        `</button>` +
        `<button type="button" class="wizard-nav__children" id="wizard-children-info" hidden>` +
          PEOPLE_SVG +
          `<span id="wizard-children-label"></span>` +
          `<span class="wc__price" id="wizard-children-price" hidden></span>` +
          CHEVRON_UP +
        `</button>` +
      `</div>` +
      `<span class="wizard-nav__indicator" id="wizard-indicator"></span>` +
      `<div class="wizard-nav__action">` +
        `<button type="button" class="btn btn--primary wizard-nav__next" id="wizard-next"><span>Següent</span>` + CHEV_RIGHT + `</button>` +
        `<button type="submit" form="form" class="btn btn--primary wizard-nav__submit" id="wizard-submit" hidden>` +
          `<span class="btn__label">${escapeHtml(submitLabel)}</span>` +
          `<span class="btn__spinner" aria-hidden="true"></span>` +
        `</button>` +
      `</div>` +
    `</div>` +
    // El text d'error es reserva al fons de la barra (sobre la franja inferior): així no
    // creix per dalt tapant el formulari, i aprofita l'espai que ja deixem lliure a baix.
    `<p class="wizard-nav__note" id="wizard-note" aria-live="polite" role="alert"></p>`;
  document.body.appendChild(nav);
  document.body.classList.add("has-wizard");

  document.getElementById("wizard-back").addEventListener("click", wizardBack);
  document.getElementById("wizard-next").addEventListener("click", wizardNext);
  document.getElementById("wizard-children-info").addEventListener("click", toggleChildrenPopup);
  document.getElementById("wizard-recover").addEventListener("click", toggleRecoverPopup);

  // Actualitza el comptador de fills en temps real quan l'usuari escriu el nom
  if (!els.sections.dataset.childInputWatch) {
    els.sections.dataset.childInputWatch = "1";
    els.sections.addEventListener("input", (e) => {
      if (wizardSteps.length && e.target.closest(".child-block")) renderWizardNav();
    });
  }

  renderWizardStep(false);   // càrrega inicial: no fem scroll (deixem veure el hero)
}

function renderWizardStep(scrollTop, dir) {
  const isLast = wizardStep === wizardSteps.length - 1;

  // Mostra només el pas actiu
  wizardSteps.forEach((s, i) => { s.hidden = i !== wizardStep; });

  // Targeta de preus i botó d'enviament: només a l'últim pas
  const priceCard = document.getElementById("price-total-card");
  if (priceCard) priceCard.hidden = !isLast;

  // Animació d'entrada direccional del pas actiu (endavant → des de la dreta, enrere → des de l'esquerra)
  const active = wizardSteps[wizardStep];
  if (active && dir) {
    active.classList.remove("section--enter-next", "section--enter-prev");
    void active.offsetWidth; // força el reinici de l'animació
    active.classList.add(dir < 0 ? "section--enter-prev" : "section--enter-next");
  }

  renderWizardNav();
  if (scrollTop) scrollToFormTop();
}

// Posiciona la vista just després del hero, amagant-lo del tot darrere el topbar sticky
// (sense deixar cap franja visible de la seva vora inferior).
function scrollToFormTop() {
  const topbar = document.querySelector(".topbar");
  const tbH = topbar ? topbar.offsetHeight : 66;
  const hero = document.getElementById("hero");
  let y;
  if (hero) {
    // Scroll fins que la base del hero coincideixi amb la base del topbar → hero tapat del tot.
    y = hero.getBoundingClientRect().bottom + window.scrollY - tbH;
  } else {
    const anchor = els.form || els.sections;
    y = anchor ? anchor.getBoundingClientRect().top + window.scrollY - tbH : 0;
  }
  // Math.ceil evita deixar un píxel subpíxel del hero per sota del topbar.
  window.scrollTo({ top: Math.max(0, Math.ceil(y)), behavior: "smooth" });
}

function renderWizardNav() {
  const isLast    = wizardStep === wizardSteps.length - 1;
  const backBtn   = document.getElementById("wizard-back");
  const nextBtn   = document.getElementById("wizard-next");
  const submitBtn = document.getElementById("wizard-submit");
  const indicator = document.getElementById("wizard-indicator");
  // Zona esquerra: resum de fills (pas 1) o botó enrere (resta de passos)
  const isChildrenStep  = wizardSteps[wizardStep] && wizardSteps[wizardStep].id === "children-section";
  const nChildren       = document.querySelectorAll(".child-block").length;
  // Comptador: només fills amb el nom omplert
  const nFilled         = [...document.querySelectorAll(".child-block")].filter(getChildName).length;
  // Preu total viu (mòbil: el mostrem aquí en comptes de la targeta del final)
  const priceSummary    = computePriceSummary();
  const grandTotal      = priceSummary ? priceSummary.grandTotal : 0;
  // El resum de fills apareix tan aviat com el primer nen té nom (indicador "1"),
  // o si ja hi ha un preu calculat. A dins hi mostrem el total quan n'hi ha.
  const showChildrenInfo = isChildrenStep && (nFilled >= 1 || grandTotal > 0);
  const childrenInfo    = document.getElementById("wizard-children-info");
  const childrenLabel   = document.getElementById("wizard-children-label");
  const recoverBtn      = document.getElementById("wizard-recover");

  // Botó de recuperació de dades: només al pas 1, si hi ha dades desades i no s'ha descartat,
  // i sense xocar amb el resum de fills. Ocupa el lloc del botó "Enrere" (invisible al pas 1).
  const showRecover = !!recoverBtn && recoverAvailable && wizardStep === 0
    && !returningDismissed && !showChildrenInfo;
  if (recoverBtn) recoverBtn.hidden = !showRecover;

  if (backBtn) {
    // Al pas 1 el botó "Enrere" no cal: deixem el lloc al resum de fills o a la
    // recuperació. A partir del pas 2 sí que cal, i pot conviure amb el resum de fills.
    if ((showChildrenInfo || showRecover) && wizardStep === 0) {
      backBtn.hidden = true;
    } else {
      backBtn.hidden = false;
      backBtn.style.visibility = wizardStep === 0 ? "hidden" : "visible";
    }
  }
  if (childrenInfo) {
    childrenInfo.hidden = !showChildrenInfo;
    childrenInfo.classList.toggle("has-price", showChildrenInfo && grandTotal > 0);
    if (showChildrenInfo) {
      if (childrenLabel) childrenLabel.textContent = String(nFilled || nChildren);
      const priceEl = document.getElementById("wizard-children-price");
      if (priceEl) {
        if (grandTotal > 0) {
          const prev = parseInt(priceEl.dataset.value || "", 10);
          priceEl.hidden = false;
          priceEl.dataset.value = String(grandTotal);
          const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          if (!reduce && Number.isFinite(prev) && prev !== grandTotal) animateCount(priceEl, prev, grandTotal);
          else priceEl.textContent = `${grandTotal} €`;
        } else {
          priceEl.hidden = true;
          priceEl.textContent = "";
          delete priceEl.dataset.value;
        }
      }
    }
  }

  // next i submit comparteixen la mateixa cel·la (.wizard-nav__action): un a la vegada
  if (nextBtn)   nextBtn.hidden   = isLast;
  if (submitBtn) submitBtn.hidden = !isLast;
  // Indicador de progrés amb punts: el pas actiu s'allarga en una píndola.
  if (indicator) {
    const n = wizardSteps.length;
    indicator.innerHTML = Array.from({ length: n }, (_, i) =>
      `<span class="wzdot${i < wizardStep ? " is-done" : i === wizardStep ? " is-active" : ""}"></span>`
    ).join("");
    indicator.setAttribute("aria-label", `Pas ${wizardStep + 1} de ${n}`);
  }
}

// ---- Children popup ----
function getChildName(block) {
  const inp = block.querySelector(
    'input[data-field*="nom"], input[data-field*="name"], input[data-field*="nombre"]'
  );
  if (inp && inp.value.trim()) return inp.value.trim();
  const first = block.querySelector('input[type="text"]');
  return first && first.value.trim() ? first.value.trim() : null;
}

function renderChildrenPopup() {
  const list = document.getElementById("wcp-list");
  if (!list) return;
  list.innerHTML = "";

  // Dades de preu per fill (subtotal + desglossament de setmanes)
  const summary   = computePriceSummary();
  const dataByIdx = {};
  if (summary) summary.children.forEach((c) => { dataByIdx[c.childIdx] = c; });

  const blocks = [...document.querySelectorAll(".child-block")];

  blocks.forEach((block, idx) => {
    const name   = getChildName(block);
    const label  = name || `Jugador/a ${idx + 1}`;
    const filled = !!name;
    const data   = dataByIdx[idx] || { total: 0, weekBreakdown: [] };
    const amount = data.total || 0;

    const item = document.createElement("div");
    item.className = "wcp__item";

    // Fila principal: avatar + nom (+ subtotal) i botó d'eliminar
    const row = document.createElement("div");
    row.className = "wcp__row";

    const scrollBtn = document.createElement("button");
    scrollBtn.type = "button";
    scrollBtn.className = "wcp__scroll-btn";
    scrollBtn.innerHTML =
      `<span class="wcp__avatar">${escapeHtml(label.charAt(0).toUpperCase())}</span>` +
      `<span class="wcp__name">${escapeHtml(label)}</span>` +
      (!filled ? `<span class="wcp__incomplete">Incomplet</span>` : "") +
      (amount > 0 ? `<span class="wcp__amount">${amount} €</span>` : "");
    scrollBtn.addEventListener("click", () => {
      closeChildrenPopup();
      expandChild(block);
      block.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    row.appendChild(scrollBtn);
    // El popup és només informatiu: eliminar fills es fa des del botó "Treure" de
    // cada bloc. Tocar una fila porta al nen corresponent.
    item.appendChild(row);

    // Desglossament: cada setmana triada amb el seu preu (la "suma" del subtotal)
    if (data.weekBreakdown.length) {
      const weeks = document.createElement("div");
      weeks.className = "wcp__weeks";
      weeks.innerHTML = data.weekBreakdown.map((w) =>
        `<div class="wcp__week">` +
          `<span class="wcp__week-label">${escapeHtml(w.label)}</span>` +
          `<span class="wcp__week-price">${w.price} €</span>` +
        `</div>`
      ).join("");
      item.appendChild(weeks);
    }

    list.appendChild(item);
  });

  // Peu amb el total general (només quan hi ha més d'un fill amb preu)
  const popup = document.getElementById("wizard-children-popup");
  const oldFoot = popup && popup.querySelector(".wcp__total");
  if (oldFoot) oldFoot.remove();
  if (popup && summary && summary.hasMulti) {
    const foot = document.createElement("div");
    foot.className = "wcp__total";
    foot.innerHTML =
      `<span class="wcp__total-label">Total</span>` +
      `<span class="wcp__total-amount">${summary.grandTotal} €</span>`;
    popup.appendChild(foot);
  }
}

function openChildrenPopup() {
  const popup   = document.getElementById("wizard-children-popup");
  const trigger = document.getElementById("wizard-children-info");
  if (!popup) return;
  closeRecoverPopup();   // mai dos popups oberts alhora
  renderChildrenPopup();
  popup.hidden = false;
  trigger && trigger.classList.add("is-open");
  // pointerdown (no click): a iOS Safari un toc en una zona no interactiva no dispara
  // "click" cap al document, i el popup no es tancava. pointerdown sí que es dispara.
  document.addEventListener("pointerdown", onOutsidePopupClick);
}

function closeChildrenPopup() {
  const popup   = document.getElementById("wizard-children-popup");
  const trigger = document.getElementById("wizard-children-info");
  if (!popup || popup.hidden) return;
  popup.hidden = true;
  trigger && trigger.classList.remove("is-open");
  document.removeEventListener("pointerdown", onOutsidePopupClick);
}

function onOutsidePopupClick(e) {
  const popup   = document.getElementById("wizard-children-popup");
  const trigger = document.getElementById("wizard-children-info");
  if (popup && trigger && !popup.contains(e.target) && !trigger.contains(e.target)) {
    closeChildrenPopup();
  }
}

function toggleChildrenPopup() {
  const popup = document.getElementById("wizard-children-popup");
  if (!popup || popup.hidden) openChildrenPopup();
  else closeChildrenPopup();
}

function validateWizardStep() {
  const step = wizardSteps[wizardStep];
  if (!step) return true;
  let ok = true, firstBad = null;
  step.querySelectorAll(".field[data-required='1']").forEach((wrap) => {
    const valid = validateSingleField(wrap);
    if (!valid) { ok = false; if (!firstBad) firstBad = wrap; }
  });
  if (CONFIG && CONFIG.settings && CONFIG.settings.semanas_obligatorias && weeksForCampus().length) {
    step.querySelectorAll("[data-weeks]").forEach((wrap) => {
      const none = !wrap.querySelector('input[type="checkbox"]:checked');
      wrap.classList.toggle("field--invalid", none);
      if (none) { ok = false; if (!firstBad) firstBad = wrap; }
    });
  }
  if (firstBad) firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
  return ok;
}

function wizardNext() {
  if (!validateWizardStep()) { haptic([10, 45, 10]); flashNote("Revisa els camps marcats."); return; }
  clearNote();
  haptic(8);
  wizardStep = Math.min(wizardStep + 1, wizardSteps.length - 1);
  // A partir del pas 2, el banner "returning" ja no cal
  if (wizardStep > 0) hideReturning();
  renderWizardStep(true, 1);
  updateProgress();
}

function wizardBack() {
  clearNote();
  haptic(6);
  wizardStep = Math.max(wizardStep - 1, 0);
  // Torna al pas 1 → re-avalua el banner (maybeShowReturning ja comprova dismissed i neteja inline styles)
  if (wizardStep === 0) maybeShowReturning();
  renderWizardStep(true, -1);
}

// El grup "per jugador/a" es repeteix per cada fill. Detectem-lo pel nom; si no,
// agafem el primer grup del formulari.
function detectChildGroup(groups) {
  const m = groups.find((g) => /jugador|alumn|fill|nen|infant|nin/i.test(g.name));
  return m ? m.name : (groups[0] && groups[0].name);
}

// Secció que conté N blocs de jugador/a + el botó "Afegir un altre fill/a".
function childrenSectionEl(num, group, fileFields) {
  const sec = sectionEl(num, group.name, []);
  sec.id = "children-section";
  const wrap = document.createElement("div"); wrap.className = "children";
  sec.appendChild(wrap);
  const add = document.createElement("button");
  add.type = "button"; add.className = "btn btn--ghost add-child";
  add.innerHTML =
    `<span class="add-child__icon" aria-hidden="true">` +
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>` +
    `</span>` +
    `<span class="add-child__text">Afegir un germà o germana</span>`;
  add.addEventListener("click", () => addChildBlock(wrap, group, fileFields));
  sec.appendChild(add);
  for (let i = 0; i < childCount; i++) wrap.appendChild(childBlockEl(group, i, fileFields));
  renumberChildren(wrap);
  return sec;
}
function childBlockEl(group, i, fileFields) {
  const block = document.createElement("div"); block.className = "child-block"; block.dataset.child = String(i);
  const head = document.createElement("div"); head.className = "child-block__head";
  head.innerHTML =
    `<span class="child-block__title"></span>` +
    `<span class="child-block__summary" aria-hidden="true"></span>` +
    `<svg class="child-block__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
  const rm = document.createElement("button");
  rm.type = "button"; rm.className = "child-block__remove"; rm.setAttribute("aria-label", "Treure aquest jugador/a");
  rm.innerHTML =
    `<svg class="child-block__remove-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>` +
    `</svg>` +
    `<span>Treure</span>`;
  rm.addEventListener("click", () => removeChildBlock(block));
  head.appendChild(rm);
  // Toggle col·laps en clicar el cap (quan hi ha >1 fills)
  head.addEventListener("click", (e) => {
    if (e.target.closest(".child-block__remove")) return;
    if (document.querySelectorAll(".child-block").length <= 1) return;
    toggleCollapseChild(block);
  });
  block.appendChild(head);
  group.fields.forEach((f) => block.appendChild(fieldEl(f, i)));
  // Camps de fitxer: un per fill, amb clau de magatzem única (c0__fieldId, c1__fieldId…)
  if (fileFields && fileFields.length) fileFields.forEach((f) => block.appendChild(fieldEl(f, i)));
  block.appendChild(discountsHeadingEl());
  block.appendChild(rdbCheckboxEl(i));
  block.appendChild(familiaNombrosaCheckboxEl(i));
  block.appendChild(childWeeksEl(i));
  return block;
}
function collapseChild(block) {
  if (!block) return;
  const summary = block.querySelector(".child-block__summary");
  if (summary) summary.textContent = getChildName(block) || "";
  block.classList.add("child-block--collapsed");
}
function expandChild(block) {
  if (!block) return;
  block.classList.remove("child-block--collapsed");
}
function toggleCollapseChild(block) {
  block.classList.contains("child-block--collapsed") ? expandChild(block) : collapseChild(block);
}

function addChildBlock(wrap, group, fileFields) {
  wrap.querySelectorAll(".child-block").forEach(collapseChild);
  const i = wrap.querySelectorAll(".child-block").length;
  wrap.appendChild(childBlockEl(group, i, fileFields));
  childCount = wrap.querySelectorAll(".child-block").length;
  renumberChildren(wrap);
  const scrollTarget = wrap.children.length >= 2 ? wrap.children[wrap.children.length - 2] : wrap.lastElementChild;
  const scrollTop = scrollTarget.getBoundingClientRect().top + window.scrollY - 140;
  window.scrollTo({ top: Math.max(0, scrollTop), behavior: "smooth" });
  renderWizardNav();
  updateProgress();
  updateAllPrices();
}
function removeChildBlock(block) {
  const wrap = block.parentElement;
  block.remove();
  // reindexa els blocs restants perquè els noms d'inputs segueixin sent únics
  [...wrap.querySelectorAll(".child-block")].forEach((b, idx) => reindexChildBlock(b, idx));
  childCount = wrap.querySelectorAll(".child-block").length || 1;
  renumberChildren(wrap);
  const remaining = wrap.querySelectorAll(".child-block");
  if (remaining.length === 1) expandChild(remaining[0]);
  scheduleDraftSave();
  renderWizardNav();
  updateProgress();
  updateAllPrices();
}
function reindexChildBlock(block, idx) {
  block.dataset.child = String(idx);
  block.querySelectorAll("[data-scope]").forEach((c) => (c.dataset.scope = String(idx)));
  // refà els noms (radio/checkbox/setmanes) que depenen de l'índex
  block.querySelectorAll("[data-field]").forEach((c) => {
    if (!("field" in c.dataset)) return;
    const nm = `c${idx}__${c.dataset.field}`;
    c.dataset.name = nm;
    c.querySelectorAll(`input`).forEach((inp) => { if (inp.name) inp.name = nm; });
  });
  block.querySelectorAll('.weeks input[type="checkbox"]').forEach((inp) => (inp.name = `c${idx}__weeks`));
}
function renumberChildren(wrap) {
  const blocks = [...wrap.querySelectorAll(".child-block")];
  const multi = blocks.length > 1;
  blocks.forEach((b, idx) => {
    b.querySelector(".child-block__title").textContent = multi ? `Jugador/a ${idx + 1}` : "Dades del jugador/a";
    const rm = b.querySelector(".child-block__remove");
    if (rm) rm.style.display = multi ? "" : "none";
    // Quan hi ha múltiples fills, el primer rep caixa igual que els altres
    b.classList.toggle("child-block--multiple", multi);
  });
}
function refreshChildWeeks() {
  document.querySelectorAll(".child-block").forEach((block) => {
    const i = Number(block.dataset.child);
    const old = block.querySelector(".child-weeks");
    if (old) old.replaceWith(childWeeksEl(i));
  });
}
function weeksTitle() { return ((CONFIG && CONFIG.settings) || {}).setmanes_titulo || "Setmanes del casal"; }
// Mostrar o no el comptador "X places disponibles" d'una setmana.
// Es controla amb la columna "mostrar_plazas" del full Semanas: només s'amaga
// si val FALSE/no/0/off. Buida o no definida → es mostra.
function showPlacesLeft(w) {
  const v = w && w.mostrar_plazas;
  if (v == null || String(v).trim() === "") return true;
  return !/^(false|no|0|off)$/i.test(String(v).trim());
}
function sectionEl(num, title, children) {
  const sec = document.createElement("section"); sec.className = "section";
  const head = document.createElement("div"); head.className = "section__head";
  head.innerHTML = `<span class="section__num">${String(num).padStart(2, "0")}</span><h2 class="section__title"></h2>`;
  head.querySelector(".section__title").textContent = title;
  sec.appendChild(head); children.forEach((c) => sec.appendChild(c));
  return sec;
}
function campusPickerEl(open) {
  const wrap = document.createElement("div"); wrap.className = "campus-pick";
  open.forEach((c) => {
    const card = document.createElement("button");
    card.type = "button"; card.className = "campus-card" + (c.id === currentCampus ? " is-selected" : "");
    card.dataset.campus = c.id;
    card.innerHTML = `<span class="campus-card__name"></span><span class="campus-card__meta"></span><span class="campus-card__check">✓</span>`;
    card.querySelector(".campus-card__name").textContent = c.nombre || c.id;
    card.querySelector(".campus-card__meta").textContent = c.fechas || "";
    card.addEventListener("click", () => {
      currentCampus = c.id;
      wrap.querySelectorAll(".campus-card").forEach((x) => x.classList.toggle("is-selected", x.dataset.campus === c.id));
      refreshChildWeeks();
      scheduleDraftSave();
    });
    wrap.appendChild(card);
  });
  return wrap;
}

function fieldEl(f, scope) {
  // nota: bloc de text sense input
  if (f.tipo === "nota") {
    const note = document.createElement("div"); note.className = "field note";
    note.dataset.id = f.id;
    if (f.etiqueta) { const t = document.createElement("p"); t.className = "note__title"; t.textContent = f.etiqueta; note.appendChild(t); }
    if (f.ayuda) { const b = document.createElement("p"); b.className = "note__body"; b.textContent = f.ayuda; note.appendChild(b); }

    // Drets d'imatge: a més del text, una casella d'acceptació obligatòria,
    // amb el mateix mecanisme que el consentiment de protecció de dades.
    if (f.id === "drets_imatge") {
      const scoped = scope != null;
      const sfx = scoped ? `_c${scope}` : "";
      const nm = scoped ? `c${scope}__${f.id}` : f.id;
      note.dataset.required = "1";
      if (scoped) note.dataset.scope = String(scope);
      const labId = `f_${f.id}${sfx}`;
      // Mateix embolcall que el consentiment de protecció de dades (.consent dins .section):
      // així hereta el mateix divisor superior i l'espaiat.
      const consent = document.createElement("div"); consent.className = "consent";
      const lab = document.createElement("label"); lab.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox"; input.id = labId; input.name = nm; input.value = "Sí";
      input.dataset.field = f.id; input.dataset.type = "checkbox"; input.dataset.name = nm;
      if (scoped) input.dataset.scope = String(scope);
      const box = document.createElement("span"); box.className = "check__box"; box.setAttribute("aria-hidden", "true");
      const span = document.createElement("span"); span.className = "check__label";
      span.textContent = "Accepto els drets d'imatge.";
      lab.append(input, box, span); consent.appendChild(lab);
      const err = document.createElement("p"); err.className = "field__error";
      err.textContent = "Cal acceptar els drets d'imatge per continuar."; consent.appendChild(err);
      note.appendChild(consent);
    }
    return note;
  }

  // Quan el camp pertany a un jugador/a concret, l'identifiquem amb un sufix
  // d'àmbit (scope) perquè els noms d'input (radio/checkbox) i els ids siguin únics.
  const scoped = scope != null;
  const sfx = scoped ? `_c${scope}` : "";
  const nm = scoped ? `c${scope}__${f.id}` : f.id;

  const wrap = document.createElement("div");
  wrap.className = "field"; wrap.dataset.id = f.id; wrap.dataset.required = f.obligatorio ? "1" : "";
  if (scoped) wrap.dataset.scope = String(scope);

  const labId = `f_${f.id}${sfx}`;
  const req = f.obligatorio ? ` <span class="field__req">*</span>` : "";
  const label = document.createElement("label");
  label.className = "field__label"; label.setAttribute("for", labId);
  label.innerHTML = escapeHtml(f.etiqueta) + req;
  wrap.appendChild(label);

  const choiceLike = ["radio", "checkbox", "file"].includes(f.tipo);
  // ajuda a sobre per a opcions/fitxers (text contextual abans del control)
  if (f.ayuda && choiceLike) {
    const help = document.createElement("p"); help.className = "field__help field__help--above";
    help.textContent = f.ayuda; wrap.appendChild(help);
  }

  let control;
  const opts = (f.opciones || "").split("|").map((o) => o.trim()).filter(Boolean);
  switch (f.tipo) {
    case "file": control = fileControl(f, labId, scope); break;
    case "textarea": control = el("textarea", "textarea"); break;
    case "select":
      control = el("select", "select");
      control.appendChild(opt("", "Tria una opció…"));
      opts.forEach((o) => control.appendChild(opt(o, o)));
      break;
    case "radio":
    case "checkbox": {
      control = document.createElement("div");
      control.className = "choices" + (f.tipo === "radio" && opts.length <= 3 ? " choices--inline" : "");
      opts.forEach((o, i) => {
        const c = document.createElement("label"); c.className = "choice";
        const input = document.createElement("input");
        input.type = f.tipo === "radio" ? "radio" : "checkbox";
        input.name = nm; input.value = o; if (i === 0) input.id = labId;
        const span = document.createElement("span"); span.textContent = o;
        c.append(input, span); control.appendChild(c);
      });
      break;
    }
    default:
      control = el("input", "input");
      control.type = ["email", "tel", "number", "date"].includes(f.tipo) ? f.tipo : "text";
      if (f.placeholder) control.placeholder = f.placeholder;
  }
  if (!control.id) control.id = labId;
  control.dataset.field = f.id; control.dataset.type = f.tipo || "text";
  control.dataset.name = nm;
  if (scoped) control.dataset.scope = String(scope);

  if (!choiceLike && control.tagName === "INPUT") {
    const AC = { nom_tutor: "name", email: "email", telefon: "tel", adreca: "street-address", codi_postal: "postal-code", poblacio: "address-level2" };
    if (AC[f.id]) control.autocomplete = AC[f.id];
    if (f.id === "codi_postal") control.inputMode = "numeric";
    if (new Set(["nom_jugador", "nom_tutor", "adreca", "poblacio"]).has(f.id)) control.setAttribute("autocapitalize", "words");
    if (f.id === "nif") control.setAttribute("autocapitalize", "characters");
  }

  wrap.appendChild(control);

  if (!choiceLike) {
    control.addEventListener("blur", () => { if (wrap.dataset.required === "1") validateSingleField(wrap); });
  }

  if (f.ayuda && !choiceLike) {
    const help = document.createElement("p"); help.className = "field__help"; help.textContent = f.ayuda; wrap.appendChild(help);
  }
  const err = document.createElement("p"); err.className = "field__error"; err.textContent = "Aquest camp és obligatori.";
  wrap.appendChild(err);
  if (f.id === "email") {
    const frag = document.createDocumentFragment();
    frag.appendChild(wrap);
    frag.appendChild(buildEmailConfirmField(scope, sfx));
    return frag;
  }
  return wrap;
}

function fileControl(f, labId, scope) {
  // Clau única per fill: "c0__targeta_sanitaria", "c1__targeta_sanitaria"…
  const storeKey = scope != null ? `c${scope}__${f.id}` : f.id;
  fileStore[storeKey] = fileStore[storeKey] || [];
  const box = document.createElement("div");
  box.className = "filebox-wrap"; box.dataset.field = f.id; box.dataset.type = "file"; box.id = labId;
  const accept = f.opciones || "image/*,application/pdf";
  const isTouch = window.matchMedia("(pointer: coarse)").matches;

  // Al mòbil: dos botons separats (càmera / arxiu). A l'escriptori: zona de drag-and-drop.
  let drop, input;
  if (isTouch) {
    drop = document.createElement("div"); drop.className = "filebox filebox--mobile";
    const btnCam = document.createElement("label"); btnCam.className = "filebox__mobile-btn";
    const inputCam = document.createElement("input");
    inputCam.type = "file"; inputCam.accept = "image/*"; inputCam.capture = "environment";
    btnCam.innerHTML = `<span class="filebox__mobile-icon" aria-hidden="true">📷</span><span>Fes una foto</span>`;
    btnCam.prepend(inputCam);

    const btnFile = document.createElement("label"); btnFile.className = "filebox__mobile-btn";
    const inputFile = document.createElement("input");
    inputFile.type = "file"; inputFile.accept = escapeHtml(accept); inputFile.multiple = true;
    btnFile.innerHTML = `<span class="filebox__mobile-icon" aria-hidden="true">📁</span><span>Tria un arxiu</span>`;
    btnFile.prepend(inputFile);

    const hint = document.createElement("p"); hint.className = "filebox__hint filebox__hint--mobile";
    hint.textContent = `Fins a ${MAX_FILE_MB} MB · Fotos i PDF`;

    drop.append(btnCam, btnFile, hint);
    // input principal = el d'arxius (el de càmera afegirà fitxers per separat)
    input = inputFile;
    // també enganxem addFiles al botó de càmera
    inputCam.addEventListener("change", (e) => addFiles(e.target.files, e.target));
  } else {
    drop = document.createElement("label"); drop.className = "filebox";
    drop.innerHTML = `<input type="file" accept="${escapeHtml(accept)}" multiple />
      <div class="filebox__icon" aria-hidden="true">📎</div>
      <div class="filebox__text">Tria fitxers o arrossega'ls aquí</div>
      <div class="filebox__hint">Fins a ${MAX_FILE_MB} MB per fitxer</div>`;
    input = drop.querySelector("input");
  }
  const chips = document.createElement("div"); chips.className = "file-chips";

  const renderChips = () => {
    chips.innerHTML = "";
    fileStore[storeKey].forEach((fl, idx) => {
      const chip = document.createElement("div"); chip.className = "file-chip";
      const isImg = (fl.mimeType || "").startsWith("image/");
      const statusHtml =
        fl.status === "uploading" ? `<span class="file-chip__status is-uploading" aria-label="Preparant…" title="Preparant…"></span>` :
        fl.status === "done"      ? `<span class="file-chip__status is-done" aria-label="A punt" title="A punt">✓</span>` : "";
      chip.innerHTML = `${isImg ? `<img class="file-chip__thumb" alt="" src="data:${fl.mimeType};base64,${fl.dataBase64}" />` : `<span class="file-chip__thumb">PDF</span>`}
        <span class="file-chip__name"></span><span class="file-chip__size">${fmtSize(fl.size)}</span>
        ${statusHtml}
        <button type="button" class="file-chip__remove" aria-label="Treure">✕</button>`;
      chip.querySelector(".file-chip__name").textContent = fl.name;
      chip.querySelector(".file-chip__remove").addEventListener("click", () => {
        removeStagedFile(fileStore[storeKey][idx]);   // aborta pujada en curs / esborra del servidor si ja s'havia pujat
        fileStore[storeKey].splice(idx, 1); renderChips();
      });
      chips.appendChild(chip);
    });
  };
  const addFiles = async (list, srcInput) => {
    for (const file of list) {
      if (file.size > MAX_FILE_MB * 1024 * 1024) { flashNote(`"${file.name}" supera els ${MAX_FILE_MB} MB.`); continue; }
      try {
        const stored = await processFileForUpload(file);
        fileStore[storeKey].push(stored); renderChips();
        // Pujada en segon pla: aprofitem el temps mentre l'usuari acaba el formulari.
        uploadStagedFile(stored, renderChips);
      }
      catch { flashNote(`No s'ha pogut llegir "${file.name}".`); }
    }
    // Reseta l'input que ha disparat l'event (per poder repetir la mateixa foto/arxiu)
    if (srcInput) srcInput.value = ""; else input.value = "";
  };
  input.addEventListener("change", (e) => addFiles(e.target.files, e.target));
  ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-drag"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer?.files) addFiles(e.dataTransfer.files); });
  box.append(drop, chips);
  return box;
}

function weeksForCampus() {
  const all = CONFIG.weeks || [];
  if (!currentCampus) return all.filter((w) => !w.campus).length ? all.filter((w) => !w.campus) : all;
  if (!all.some((w) => w.campus)) return all;
  return all.filter((w) => w.campus === currentCampus);
}
function buildPriceTableFromConfig() {
  const refWeek = (CONFIG.weeks || []).find(function(w) { return w.p1 != null; });
  if (!refWeek) return null;
  const p1  = refWeek.p1;
  const p2  = refWeek.p2  != null ? refWeek.p2  : p1;
  const p1r = refWeek.p1_rdb != null ? refWeek.p1_rdb : p1;
  const p2r = refWeek.p2_rdb != null ? refWeek.p2_rdb : p2;

  const isMulti = (CONFIG.weeks || []).length > 1 && p1 !== p2;
  const hasRDB   = p1r !== p1 || p2r !== p2;

  // Files de la taula: (label, preu general, preu RDB)
  const rows = [];
  rows.push({ label: isMulti ? "1a setmana" : "General", gen: p1, rdb: p1r });
  if (isMulti) {
    rows.push({ label: "2a setmana · 2n germà/na · família nombrosa", gen: p2, rdb: p2r });
  } else if (p2 !== p1) {
    rows.push({ label: "Germà/na · família nombrosa",  gen: p2, rdb: p2r });
  }

  // data-label permet que al mòbil cada preu mostri a quina columna pertany
  // (la capçalera de la taula s'amaga i cada fila es converteix en una targeta).
  const priceCell = function(val, isRdb, head) {
    return `<td data-label="${escapeHtml(head)}"><span class="price-table__price${isRdb ? " price-table__price--rdb" : ""}">${val}&thinsp;€</span></td>`;
  };

  const rowsHtml = rows.map(function(r) {
    return `<tr>
      <td class="price-table__label">${escapeHtml(r.label)}</td>
      ${priceCell(r.gen, false, "General")}
      ${hasRDB ? priceCell(r.rdb, true, "C.P. Riudebitlles") : ""}
    </tr>`;
  }).join("");

  const card = document.createElement("div");
  card.className = "price-info";
  card.innerHTML = `<button type="button" class="price-info__header" aria-expanded="false" aria-controls="price-info-body">
    <span class="price-info__icon" aria-hidden="true">€</span>
    <span class="price-info__title">Preus</span>
    <span class="price-info__hint">Veure tarifes</span>
    <svg class="price-info__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
  </button>
  <div class="price-info__body" id="price-info-body">
    <div class="price-info__body-inner">
      <table class="price-table">
        <thead><tr>
          <th></th>
          <th>General</th>
          ${hasRDB ? "<th>C.P. Riudebitlles</th>" : ""}
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
  const toggle = card.querySelector(".price-info__header");
  const hint   = card.querySelector(".price-info__hint");
  toggle.addEventListener("click", function() {
    const open = card.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (hint) hint.textContent = open ? "Amaga" : "Veure tarifes";
  });
  return card;
}

function childWeeksEl(i) {
  const wrap = document.createElement("div"); wrap.className = "field child-weeks"; wrap.dataset.weeks = "1"; wrap.dataset.child = String(i);
  const head = document.createElement("div"); head.className = "child-weeks__head";
  head.innerHTML =
    `<span class="child-weeks__icon" aria-hidden="true">` +
      `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>` +
      `</svg>` +
    `</span>` +
    `<span class="child-weeks__titles">` +
      `<span class="child-weeks__eyebrow">Tria</span>` +
      `<span class="child-weeks__title">${escapeHtml(weeksTitle())}</span>` +
    `</span>`;
  wrap.appendChild(head);
  const list = document.createElement("div"); list.className = "weeks";
  const weeks = weeksForCampus();
  if (!weeks.length) { const p = document.createElement("p"); p.className = "field__help"; p.textContent = "Aquest casal encara no té setmanes definides."; wrap.appendChild(p); return wrap; }

  if (i === 0) {
    const priceTableEl = buildPriceTableFromConfig();
    if (priceTableEl) wrap.appendChild(priceTableEl);
  }

  weeks.forEach((w, idx) => {
    const full = w.plazas_restantes != null && Number(w.plazas_restantes) <= 0;
    const lab = document.createElement("label"); lab.className = "week" + (full ? " is-full" : ""); lab.dataset.week = w.id;
    const input = document.createElement("input");
    input.type = "checkbox"; input.value = w.id; input.name = `c${i}__weeks`; input.disabled = full;
    input.addEventListener("change", () => { lab.classList.toggle("is-selected", input.checked); if (navigator.vibrate) navigator.vibrate(10); });
    const placesPill = (!full && w.plazas_restantes != null && showPlacesLeft(w))
      ? `<span class="week__places">${w.plazas_restantes} places</span>` : "";
    const fullTag = full ? `<span class="week__tag">Complet</span>` : "";
    lab.innerHTML = `<span class="week__num">${idx + 1}</span>` +
      `<span class="week__body">` +
        `<span class="week__label">${escapeHtml(w.etiqueta)}</span>` +
        `<span class="week__meta">${escapeHtml(w.fechas || "")}</span>` +
        placesPill +
      `</span>` +
      fullTag +
      `<span class="week__check">✓</span>`;
    lab.prepend(input); list.appendChild(lab);
  });
  wrap.appendChild(list);
  const err = document.createElement("p"); err.className = "field__error"; err.textContent = "Tria almenys una setmana.";
  wrap.appendChild(err);
  const priceEl = document.createElement("div"); priceEl.className = "child-price"; priceEl.hidden = true;
  priceEl.innerHTML =
    '<span class="child-price__icon" aria-hidden="true">€</span>' +
    '<div class="child-price__body">' +
      '<span class="child-price__label">Subtotal d\'aquest jugador/a</span>' +
      '<span class="child-price__breakdown"></span>' +
    '</div>' +
    '<span class="child-price__amount"></span>';
  wrap.appendChild(priceEl);
  return wrap;
}

// ---- Recollida + validació ----
function validateSingleField(wrap) {
  const c = wrap.querySelector("[data-field]");
  if (!c) return true;
  const errEl = wrap.querySelector(".field__error");
  let empty = false;
  if (c.dataset.type === "file") {
    const key = (c.dataset.scope != null && c.dataset.scope !== "")
      ? `c${c.dataset.scope}__${c.dataset.field}` : c.dataset.field;
    empty = !(fileStore[key] && fileStore[key].length);
  } else if (c.dataset.type === "checkbox" || c.dataset.type === "radio") {
    empty = !wrap.querySelector("input:checked");
    // Drets d'imatge: casella d'acceptació obligatòria, com el consentiment de protecció de dades.
    if (empty && c.dataset.field === "drets_imatge" && errEl) errEl.textContent = "Cal acceptar els drets d'imatge per continuar.";
  } else {
    const val = c.value.trim();
    empty = !val;
    if (!empty) {
      if ((c.dataset.type === "email" || c.dataset.field === "email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) {
        empty = true; if (errEl) errEl.textContent = "Introdueix un correu vàlid.";
      } else if (c.dataset.field === "email_confirm") {
        const sc = c.dataset.scope;
        const emailSel = (sc != null && sc !== "")
          ? `.child-block[data-child="${sc}"] [data-field="email"]`
          : `[data-field="email"]:not([data-scope])`;
        const ref = document.querySelector(emailSel);
        if (!ref || ref.value.trim() !== val) {
          empty = true; if (errEl) errEl.textContent = "Els correus no coincideixen.";
        }
      } else if (c.dataset.field === "nif" && !/^\d{8}[A-Za-z]$|^[XYZ]\d{7}[A-Za-z]$/i.test(val)) {
        empty = true; if (errEl) errEl.textContent = "Format de NIF no vàlid (p.ex. 12345678A).";
      } else if (c.dataset.field === "codi_postal" && !/^\d{5}$/.test(val)) {
        empty = true; if (errEl) errEl.textContent = "El codi postal ha de tenir 5 dígits.";
      } else if (c.dataset.field === "telefon" && !/^[0-9\s+\-.]{7,15}$/.test(val)) {
        empty = true; if (errEl) errEl.textContent = "Introdueix un telèfon vàlid.";
      } else {
        if (errEl) errEl.textContent = "Aquest camp és obligatori.";
      }
    }
  }
  wrap.classList.toggle("field--invalid", empty);
  return !empty;
}
function buildEmailConfirmField(scope, sfx) {
  const scoped = scope != null;
  const labId = `f_email_confirm${sfx || ""}`;
  const nm = scoped ? `c${scope}__email_confirm` : "email_confirm";
  const wrap = document.createElement("div");
  wrap.className = "field"; wrap.dataset.id = "email_confirm"; wrap.dataset.required = "1";
  if (scoped) wrap.dataset.scope = String(scope);
  const label = document.createElement("label");
  label.className = "field__label"; label.setAttribute("for", labId);
  label.innerHTML = `Confirma el correu electrònic <span class="field__req">*</span>`;
  wrap.appendChild(label);
  const input = document.createElement("input");
  input.type = "email"; input.id = labId; input.className = "input";
  input.autocomplete = "off";
  input.dataset.field = "email_confirm"; input.dataset.type = "email_confirm";
  input.dataset.name = nm;
  if (scoped) input.dataset.scope = String(scope);
  input.addEventListener("blur", () => validateSingleField(wrap));
  wrap.appendChild(input);
  const err = document.createElement("p"); err.className = "field__error"; err.textContent = "Els correus no coincideixen.";
  wrap.appendChild(err);
  return wrap;
}
function syncEmailConfirmIn(root) {
  root.querySelectorAll('[data-field="email"]').forEach((emailEl) => {
    if (!emailEl.value) return;
    const scope = emailEl.dataset.scope;
    const sel = (scope != null && scope !== "")
      ? `[data-field="email_confirm"][data-scope="${scope}"]`
      : '[data-field="email_confirm"]:not([data-scope])';
    const confirmEl = root.querySelector(sel);
    if (confirmEl) confirmEl.value = emailEl.value;
  });
}
// Llegeix el valor d'un control (input/select/choices) dins d'una arrel donada.
function readControl(c, root) {
  if (c.dataset.type === "checkbox") return [...root.querySelectorAll(`input[name="${c.dataset.name}"]:checked`)].map((i) => i.value).join(", ");
  if (c.dataset.type === "radio") { const sel = root.querySelector(`input[name="${c.dataset.name}"]:checked`); return sel ? sel.value : ""; }
  return c.value.trim();
}
function collect() {
  // Camps compartits (tutor, autoritzacions…): tots els que NO pertanyen a un bloc de fill.
  const shared = {};
  els.sections.querySelectorAll("[data-field]").forEach((c) => {
    if (c.dataset.scope != null && c.dataset.scope !== "") return; // és d'un fill → s'agafa a sota
    if (c.dataset.type === "file") return; // fitxers sempre van dins dels blocs de fill
    if (c.dataset.field === "email_confirm") return;
    shared[c.dataset.field] = readControl(c, els.sections);
  });

  // Un bloc per cada jugador/a: dades pròpies + fitxers propis + setmanes pròpies.
  const children = [];
  document.querySelectorAll(".child-block").forEach((block) => {
    const blockIdx = Number(block.dataset.child);
    const data = {};
    block.querySelectorAll("[data-field]").forEach((c) => {
      if (c.dataset.type === "file") return;
      if (c.dataset.field === "email_confirm") return;
      data[c.dataset.field] = readControl(c, block);
    });
    const weeks = [...block.querySelectorAll(".weeks input:checked")].map((i) => i.value);
    // Fitxers d'aquest fill concret (clau: c0__fieldId, c1__fieldId…)
    const files = [];
    Object.keys(fileStore).forEach((key) => {
      if (!key.startsWith(`c${blockIdx}__`)) return;
      const fieldId = key.slice(`c${blockIdx}__`.length);
      fileStore[key].forEach((fl) => {
        // Si la foto ja s'ha pujat en segon pla, enviem només la referència (ràpid);
        // si no (sense servidor, error o encara local), s'envia inline en base64.
        if (fl.status === "done" && fl.ref) files.push({ field: fieldId, name: fl.name, mimeType: fl.mimeType, ref: fl.ref });
        else files.push({ field: fieldId, name: fl.name, mimeType: fl.mimeType, dataBase64: fl.dataBase64 });
      });
    });
    children.push({ data, weeks, files });
  });
  return { shared, children };
}
function validate() {
  let ok = true, firstBad = null;
  els.sections.querySelectorAll(".field[data-required='1']").forEach((wrap) => {
    const valid = validateSingleField(wrap);
    if (!valid) { ok = false; if (!firstBad) firstBad = wrap; }
  });
  // Setmanes obligatòries: cada jugador/a n'ha de tenir almenys una.
  if (CONFIG.settings && CONFIG.settings.semanas_obligatorias && weeksForCampus().length) {
    els.sections.querySelectorAll("[data-weeks]").forEach((wrap) => {
      const none = !wrap.querySelector('input[type="checkbox"]:checked');
      wrap.classList.toggle("field--invalid", none);
      if (none && !firstBad) firstBad = wrap; if (none) ok = false;
    });
  }
  return { ok, firstBad };
}

// Etiqueta llegible d'un camp obligatori (per dir a l'usuari QUIN falla).
function fieldLabel(wrap) {
  if (!wrap) return "aquest camp";
  if (wrap.id === "consent" || wrap.querySelector?.("#consent")) return "la política de protecció de dades";
  const el = wrap.querySelector?.(".field__label, .note__title, .child-weeks__title, .check__label");
  const t = ((el ? el.textContent : wrap.textContent) || "").replace(/\*/g, "").trim();
  return t || "aquest camp";
}

// Porta el camp a la vista: desplega el bloc de fill plegat, salta al pas del wizard
// que el conté i hi fa scroll + focus. Així clicar "Enviar" sempre porta on falta.
function revealField(wrap) {
  if (!wrap) return;
  const block = wrap.closest(".child-block");
  if (block && block.classList.contains("child-block--collapsed")) expandChild(block);
  if (wizardSteps.length) {
    const section = wrap.closest(".section");
    const stepIdx = section ? wizardSteps.indexOf(section) : -1;
    if (stepIdx >= 0 && stepIdx !== wizardStep) { wizardStep = stepIdx; renderWizardStep(false); }
  }
  wrap.scrollIntoView({ behavior: "smooth", block: "center" });
  const focusable = wrap.querySelector("input:not([type=hidden]), select, textarea");
  if (focusable && focusable.focus) { try { focusable.focus({ preventScroll: true }); } catch {} }
}

// ---- Enviament ----
async function onSubmit(e) {
  e.preventDefault();
  clearNote();
  const consentInput = document.getElementById("consent");
  if (!consentInput.checked) {
    haptic([10, 45, 10]);
    const consentWrap = consentInput.closest(".consent");
    if (consentWrap) consentWrap.classList.add("consent--invalid");
    revealField(consentWrap || consentInput);
    return flashNote("Cal acceptar la política de protecció de dades.");
  }
  const { ok: formOk, firstBad } = validate();
  if (!formOk) {
    haptic([10, 45, 10]);
    revealField(firstBad);
    return flashNote(`Falta un camp: ${fieldLabel(firstBad)}.`);
  }
  setLoading(true);
  try {
    // Espera les pujades en segon pla que encara estiguin en curs (normalment ja fetes,
    // perquè s'han anat pujant mentre l'usuari omplia el formulari).
    const pendingUploads = [];
    Object.keys(fileStore).forEach((k) => (fileStore[k] || []).forEach((fl) => {
      if (fl && fl.status === "uploading" && fl._promise) pendingUploads.push(fl._promise);
    }));
    if (pendingUploads.length) await Promise.allSettled(pendingUploads);

    const { shared, children } = collect();
    // Mida total només dels fitxers que s'envien inline (els ja pujats no compten).
    const totalBytes = children.reduce((sum, ch) =>
      sum + (ch.files || []).reduce((s, f) => s + (f.dataBase64 ? f.dataBase64.length * 0.75 : 0), 0), 0);
    if (totalBytes > MAX_TOTAL_MB * 1024 * 1024) { flashNote(`Els fitxers sumen massa (màx ${MAX_TOTAL_MB} MB).`); return; }
    const campus = (CONFIG.campuses || []).find((c) => c.id === currentCampus);
    const all = weeksForCampus();
    const childrenPayload = children.map((ch, chIdx) => {
      const isRDB = ch.data.is_rdb === "Sí";
      const isFN = ch.data.familia_nombrosa === "Sí";
      let preu = null, descompte = "";
      if (hasPriceConfig() && ch.weeks.length > 0) {
        preu = ch.weeks.reduce((sum, weekId, weekIdx) => sum + calcWeekPrice(chIdx, weekIdx, isRDB, isFN, getWeekPrices(weekId)), 0);
        const d = [];
        if (isRDB) d.push("C.P. Riudebitlles");
        if (isFN) d.push("Família nombrosa");
        if (chIdx > 0) d.push("Germà/na");
        descompte = d.join(", ") || "-";
      }
      return {
        data: ch.data,
        weeks: ch.weeks,
        files: ch.files || [],
        weekLabels: all.filter((w) => ch.weeks.includes(w.id)).map((w) => `${w.id} (${w.fechas || w.etiqueta})`),
        preu,
        descompte
      };
    });
    const campusName = campus ? campus.nombre : "";
    const payload = {
      form: activeFormId, formName: (CONFIG.form && CONFIG.form.nombre) || (CONFIG.settings && CONFIG.settings.hero_titulo) || activeFormId,
      campusId: currentCampus || "", campusName,
      shared, children: childrenPayload, ts: new Date().toISOString()
    };

    const result = await send(payload);
    submissionDone = true;   // ja no esborrarem les fotos pujades en abandonar
    saveLocal(shared, childrenPayload, campusName);
    showDone(shared, childrenPayload, campusName, result);
  } catch (err) { console.error(err); flashNote("No s'ha pogut enviar. Torna-ho a provar en uns segons."); }
  finally { setLoading(false); }
}
async function send(payload) {
  if (!SCRIPT_URL) { await new Promise((r) => setTimeout(r, 700)); return { ok: true, demo: true, id: "DEMO-" + Date.now() }; }
  const res = await fetch(SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "error servidor");
  return out;
}
let noteTimer = null;
function clearNote() {
  if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
  [els.submitNote, document.getElementById("wizard-note")].forEach((n) => {
    if (!n) return; n.textContent = ""; n.classList.remove("is-error");
  });
}
function setLoading(on) {
  [els.submitBtn, document.getElementById("wizard-submit")].forEach((btn) => {
    if (!btn) return;
    btn.disabled = on; btn.classList.toggle("is-loading", on);
  });
}
function flashNote(msg) {
  const target = document.getElementById("wizard-note") || els.submitNote;
  target.textContent = msg; target.classList.add("is-error");
  // El missatge (toast) marxa sol als 3 segons; un nou flashNote reinicia el compte.
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = setTimeout(clearNote, 3000);
}
// Vibració tàctil (només mòbils que ho suporten). Patró: ms o [vibra, pausa, vibra…].
function haptic(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
}

// ---- Èxit ----
function showDone(shared, children, campusName, result) {
  els.form.hidden = true; els.returning.hidden = true; els.done.hidden = false;
  document.body.classList.add("page--done");
  haptic([14, 60, 14, 60, 26]); // petita celebració tàctil
  launchConfetti();
  const s = CONFIG.settings || {};
  els.doneText.textContent = (s.mensaje_exito || "Inscripció rebuda correctament.") + (result && result.demo ? "  (mode demo: encara no s'ha guardat enlloc)" : "");
  const refEl = document.getElementById("done-ref");
  if (refEl) {
    if (result && result.id && !result.demo) {
      refEl.textContent = `Ref. ${result.id}`;
      refEl.hidden = false;
    } else {
      refEl.hidden = true;
    }
  }
  const items = [];
  if (campusName) items.push(["Casal", campusName]);
  children.forEach((ch, i) => {
    const name = ch.data.nom_jugador || pickName(ch.data);
    if (!name && !(ch.weekLabels || []).length) return;
    const key = children.length > 1 ? `Jugador/a ${i + 1}` : "Jugador/a";
    const val = [name, (ch.weekLabels || []).join(", ")].filter(Boolean).join(" · ");
    items.push([key, val]);
  });
  const email = findEmail(shared);
  if (email) items.push(["Correu", email]);
  els.doneSummary.innerHTML = "<dl>" + items.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("") + "</dl>";
  window.scrollTo({ top: 0, behavior: "smooth" });
  updateAllPrices();
  updateProgress();
}
function resetForNew() {
  els.done.hidden = true; els.form.hidden = false; els.form.reset();
  document.body.classList.remove("page--done");
  submissionDone = false;   // nova inscripció: torna a netejar fotos si s'abandona
  Object.keys(fileStore).forEach((k) => (fileStore[k] = []));
  childCount = 1;
  returningDismissed = false;
  try { sessionStorage.removeItem(RETURNING_DISMISSED_KEY); } catch {}
  renderForm(); els.submitNote.textContent = ""; maybeShowReturning();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- localStorage ----
function loadLocal() {
  try {
    const store = JSON.parse(localStorage.getItem(STORAGE_KEY)) || { families: [] };
    const draft = loadDraft();
    const families = [...(store.families || [])].filter((entry) => shouldKeepLocalEntry(entry));
    if (draft && familyLabel(draft)) {
      const draftKey = familyKey(draft);
      const duplicate = families.find((f) => familyKey(f) === draftKey);
      if (!duplicate) families.unshift(draft);
    }
    return { families };
  } catch {
    const draft = loadDraft();
    return { families: draft ? [draft] : [] };
  }
}
function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY)) || null;
    return shouldKeepLocalEntry(draft) ? draft : null;
  }
  catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}
function currentCampusName() {
  const campus = (CONFIG && CONFIG.campuses || []).find((c) => c.id === currentCampus);
  return campus ? campus.nombre : "";
}
function buildLocalEntry(shared, children, campusName, source) {
  const email = findEmail(shared);
  return {
    email,
    shared,
    campusName,
    ts: Date.now(),
    source: source || "saved",
    children: (children || []).map((ch) => ({ data: ch.data, weeks: ch.weeks, weekLabels: ch.weekLabels || [] }))
  };
}
function scheduleDraftSave() {
  if (!CONFIG || els.form.hidden) return;
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftFromForm, 250);
}
// Coalesça progrés + preus en una sola actualització per frame: així escriure ràpid
// (o un checkbox que dispara input+change alhora) no recalcula tot el formulari N cops.
let uiUpdateScheduled = false;
function scheduleUiUpdate() {
  if (uiUpdateScheduled) return;
  uiUpdateScheduled = true;
  requestAnimationFrame(() => {
    uiUpdateScheduled = false;
    updateProgress();
    updateAllPrices();
  });
}
function saveDraftFromForm() {
  draftSaveTimer = null;
  if (!CONFIG || els.form.hidden) return;
  const { shared, children } = collect();
  const entry = buildLocalEntry(shared, children, currentCampusName(), "draft");
  if (!shouldKeepLocalEntry(entry)) { clearDraft(); return; }
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(entry)); } catch {}
}
function loadReturningDismissed() {
  try { return sessionStorage.getItem(RETURNING_DISMISSED_KEY) === "1"; }
  catch { return false; }
}
function dismissReturning(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  returningDismissed = true;
  try { sessionStorage.setItem(RETURNING_DISMISSED_KEY, "1"); } catch {}
  hideReturning();
}
function setReturningOpen(open) {
  if (!els.returning) return;
  els.returning.toggleAttribute("data-open", !!open);
  if (els.returningToggle) els.returningToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function toggleReturning() {
  setReturningOpen(!els.returning?.hasAttribute("data-open"));
}
function childDisplayName(child, idx) {
  return (child && child.data && (child.data.nom_jugador || pickName(child.data))) || `Jugador/a ${idx + 1}`;
}
function familyNames(entry) {
  return (entry.children || []).map((ch, idx) => childDisplayName(ch, idx)).filter(Boolean);
}
function familyLabel(entry) {
  const names = familyNames(entry);
  return names.join(" + ") || entry.email || "";
}
function shouldKeepLocalEntry(entry) {
  if (!entry) return false;
  if (entry.source === "draft" && !familyIdentityKey(entry)) return false;
  return !!familyLabel(entry);
}
function familyIdentityKey(entry) {
  const shared = (entry && entry.shared) || {};
  const nif = firstMatchingValue(shared, [/^nif$/i, /document/i, /dni/i]);
  if (nif) return `nif:${normalizeKey(nif)}`;

  const email = findEmail(shared) || entry.email;
  if (email) return `email:${normalizeKey(email)}`;

  const tutor = firstMatchingValue(shared, [/tutor/i, /pare/i, /mare/i, /padre/i, /madre/i]);
  const phone = firstMatchingValue(shared, [/telefon/i, /telefono/i, /mobil/i, /movil/i, /phone/i]);
  if (tutor || phone) return `contacte:${normalizeKey(tutor)}|${normalizeKey(phone)}`;

  return "";
}
function familyKey(entry) {
  return familyIdentityKey(entry) || familyLabel(entry).toLowerCase();
}
function firstMatchingValue(data, patterns) {
  if (!data) return "";
  for (const key of Object.keys(data)) {
    if (patterns.some((pattern) => pattern.test(key)) && String(data[key] || "").trim()) return String(data[key]).trim();
  }
  return "";
}
function normalizeKey(v) {
  return String(v || "").trim().toLowerCase().replace(/\s+/g, "");
}
function saveLocal(shared, children, campusName) {
  const entry = buildLocalEntry(shared, children, campusName, "saved");
  clearDraft();
  const store = loadLocal();
  const key = familyKey(entry);
  store.families = (store.families || []).filter((f) => familyKey(f) !== key);
  store.families.unshift(entry); store.families = store.families.slice(0, 8);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
}
function maybeShowReturning() {
  if (returningDismissed) { hideReturning(); return; }
  const store = loadLocal();
  // Només mostrem inscripcions anteriors amb dades útils (nom o correu).
  const fams = mergeFamiliesByKey((store.families || []).filter((f) => familyLabel(f)));
  if (!fams.length) { recoverAvailable = false; hideReturning(); return; }
  recoverAvailable = true;

  // Mòbil amb wizard actiu: la recuperació viu a la barra de navegació, no al banner.
  // (Si no hi ha barra —p. ex. formulari d'un sol pas— caiem al banner.)
  const list = document.getElementById("wizard-recover-list");
  if (window.matchMedia("(pointer: coarse)").matches && list) {
    if (els.returning) { els.returning.hidden = true; els.returning.style.display = "none"; }
    renderRecoverChips(list, fams);
    renderWizardNav();   // decideix si es mostra la icona (pas 1, no descartat…)
    return;
  }

  // Escriptori: banner desplegable. Amb el rail actiu (PC ample) viu a la columna
  // dreta, sobre el resum; si no, fa de banner superior com sempre.
  els.returningText.textContent = "Recupera dades d'una inscripció anterior:";
  renderRecoverChips(els.returningActions, fams);
  setReturningOpen(false);
  els.returning.hidden = false;
  els.returning.style.display = "";
  renderPcSummary();   // recalcula l'alineació de la columna dreta
}

// Construeix els grups de família + chips de fill dins d'un contenidor donat.
function renderRecoverChips(container, fams) {
  container.innerHTML = "";
  fams.forEach((f) => {
    const group = document.createElement("div"); group.className = "returning-family";

    const groupLabel = fams.length > 1 ? familyLabel(f) : (f.email || "");
    if (groupLabel) {
      const titleEl = document.createElement("p"); titleEl.className = "returning-family__title";
      titleEl.textContent = groupLabel;
      group.appendChild(titleEl);
    }

    const actions = document.createElement("div"); actions.className = "returning-family__actions";
    if ((f.children || []).length > 1) {
      const allBtn = document.createElement("button");
      allBtn.type = "button";
      allBtn.className = "chip chip--all";
      allBtn.textContent = `Tots dos fills`;
      if (f.children.length !== 2) allBtn.textContent = `Tots ${f.children.length} fills`;
      allBtn.addEventListener("click", () => {
        returningDismissed = true;
        prefillFamilySelection(f, f.children.map((_, idx) => idx));
        hideReturning();
      });
      actions.appendChild(allBtn);
    }

    (f.children || []).forEach((child, idx) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "chip chip--with-delete";
      const dispName = childDisplayName(child, idx);
      const avatar = document.createElement("span");
      avatar.className = "chip__avatar"; avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = (dispName.trim()[0] || "?").toUpperCase();
      const nameSpan = document.createElement("span"); nameSpan.textContent = dispName;
      const delSpan = document.createElement("span");
      delSpan.className = "chip__del";
      delSpan.setAttribute("aria-label", `Esborrar ${dispName} de la memòria`);
      delSpan.textContent = "×";
      delSpan.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeCachedChild(f, idx);
      });
      b.append(avatar, nameSpan, delSpan);
      b.addEventListener("click", () => {
        returningDismissed = true;
        prefillFamilySelection(f, [idx]);
        hideReturning();
      });
      actions.appendChild(b);
    });

    group.appendChild(actions);
    container.appendChild(group);
  });
}
function mergeFamiliesByKey(families) {
  const grouped = new Map();
  (families || []).forEach((entry) => {
    const key = familyKey(entry);
    if (!key) return;
    if (!grouped.has(key)) {
      grouped.set(key, { ...entry, children: [...(entry.children || [])] });
      return;
    }
    const current = grouped.get(key);
    const mergedChildren = [...(current.children || [])];
    (entry.children || []).forEach((child) => mergeChildIntoList(mergedChildren, child));
    if ((entry.ts || 0) > (current.ts || 0)) {
      current.shared = entry.shared || current.shared;
      current.email = entry.email || current.email;
      current.campusName = entry.campusName || current.campusName;
      current.ts = entry.ts;
      current.source = entry.source || current.source;
    }
    current.children = mergedChildren;
  });
  return [...grouped.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function mergeChildIntoList(children, child) {
  const idx = children.findIndex((existing) => sameCachedChild(existing, child));
  if (idx === -1) {
    children.push(child);
    return;
  }
  children[idx] = mergeChildRecords(children[idx], child);
}
function sameCachedChild(a, b) {
  const aName = normalizeKey(a && a.data && (a.data.nom_jugador || pickName(a.data)));
  const bName = normalizeKey(b && b.data && (b.data.nom_jugador || pickName(b.data)));
  const aBirth = normalizeKey(findChildBirthdate(a && a.data));
  const bBirth = normalizeKey(findChildBirthdate(b && b.data));
  if (aName && bName && aName === bName) return !aBirth || !bBirth || aBirth === bBirth;
  return !!aBirth && aBirth === bBirth;
}
function mergeChildRecords(base, incoming) {
  const mergedData = { ...((base && base.data) || {}) };
  Object.keys((incoming && incoming.data) || {}).forEach((key) => {
    const next = incoming.data[key];
    if (next != null && String(next).trim() !== "") mergedData[key] = next;
  });
  return {
    data: mergedData,
    weeks: ((incoming && incoming.weeks) || (base && base.weeks) || []).slice(),
    weekLabels: ((incoming && incoming.weekLabels) || (base && base.weekLabels) || []).slice()
  };
}
function childCacheKey(child) {
  if (!child || !child.data) return "";
  const name = normalizeKey(child.data.nom_jugador || pickName(child.data));
  const birth = normalizeKey(findChildBirthdate(child.data));
  return `${name}|${birth}`;
}
function findChildBirthdate(data) {
  if (!data) return "";
  for (const key of Object.keys(data)) {
    if (/naix|nacim|birth/i.test(key) && String(data[key] || "").trim()) return String(data[key]).trim();
  }
  return "";
}
function hideReturning() {
  if (els.returning) {
    els.returning.hidden = true;
    els.returning.setAttribute("hidden", "");
    els.returning.style.display = "none";
  }
  // També amaga la icona de recuperació de la barra (mòbil) i tanca el seu popup.
  const recoverBtn = document.getElementById("wizard-recover");
  if (recoverBtn) recoverBtn.hidden = true;
  closeRecoverPopup();
  // Al PC, en amagar-se el "ja t'havíem vist" cal recalcular l'alineació del rail.
  renderPcSummary();
}

// ---- Popup de recuperació (barra del wizard, mòbil) ----
function openRecoverPopup() {
  const popup   = document.getElementById("wizard-recover-popup");
  const trigger = document.getElementById("wizard-recover");
  if (!popup) return;
  closeChildrenPopup();   // mai dos popups oberts alhora
  popup.hidden = false;
  trigger && trigger.classList.add("is-open");
  document.addEventListener("pointerdown", onOutsideRecoverClick);  // pointerdown: fiable amb el toc a iOS
}
function closeRecoverPopup() {
  document.removeEventListener("pointerdown", onOutsideRecoverClick);  // sempre, encara que el popup ja no existeixi
  const popup   = document.getElementById("wizard-recover-popup");
  const trigger = document.getElementById("wizard-recover");
  if (!popup || popup.hidden) return;
  popup.hidden = true;
  trigger && trigger.classList.remove("is-open");
}
function onOutsideRecoverClick(e) {
  const popup   = document.getElementById("wizard-recover-popup");
  const trigger = document.getElementById("wizard-recover");
  if (popup && trigger && !popup.contains(e.target) && !trigger.contains(e.target)) {
    closeRecoverPopup();
  }
}
function toggleRecoverPopup() {
  const popup = document.getElementById("wizard-recover-popup");
  if (!popup || popup.hidden) openRecoverPopup();
  else closeRecoverPopup();
}
function removeCachedChild(entry, childIdx) {
  const key = familyKey(entry);
  const child = entry && entry.children && entry.children[childIdx];
  if (!key || !child) return;
  const rawStore = readRawStore();
  const matching = (rawStore.families || []).filter((f) => familyKey(f) === key);
  if (!matching.length) return;

  const merged = mergeFamiliesByKey(matching)[0];
  if (!merged) return;
  merged.children = (merged.children || []).filter((_, idx) => idx !== childIdx);

  rawStore.families = (rawStore.families || []).filter((f) => familyKey(f) !== key);
  if (merged.children.length) {
    merged.ts = Date.now();
    rawStore.families.unshift(merged);
  }
  rawStore.families = rawStore.families.slice(0, 8);
  writeRawStore(rawStore);

  const draft = loadDraft();
  if (draft && familyKey(draft) === key) {
    draft.children = (draft.children || []).filter((candidate) => !sameCachedChild(candidate, child));
    if (draft.children.length && shouldKeepLocalEntry(draft)) {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
    } else {
      clearDraft();
    }
  }
  maybeShowReturning();
}
function readRawStore() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { families: [] }; }
  catch { return { families: [] }; }
}
function writeRawStore(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store || { families: [] })); } catch {}
}
// Omple els controls (no-fitxer) d'una arrel amb les dades d'un objecte.
function fillControlsIn(root, data, skipScoped) {
  root.querySelectorAll("[data-field]").forEach((c) => {
    if (skipScoped && c.dataset.scope != null && c.dataset.scope !== "") return;
    const id = c.dataset.field;
    if (c.dataset.type === "file" || !data || !(id in data)) return;
    const val = data[id];
    if (c.dataset.type === "checkbox") { const set = new Set(String(val).split(",").map((x) => x.trim())); root.querySelectorAll(`input[name="${c.dataset.name}"]`).forEach((i) => (i.checked = set.has(i.value))); }
    else if (c.dataset.type === "radio") { root.querySelectorAll(`input[name="${c.dataset.name}"]`).forEach((i) => { i.checked = i.value === val; i.closest(".choice")?.classList.toggle("is-on", i.checked); }); }
    else c.value = val;
  });
}
function prefillFamilySelection(entry, selectedIdxs) {
  const selected = (selectedIdxs || [])
    .map((idx) => entry.children && entry.children[idx])
    .filter(Boolean);
  if (!selected.length) return;

  // Recrea tants blocs de fill com s'hagin seleccionat.
  childCount = Math.max(1, selected.length);
  renderForm();
  fillControlsIn(els.sections, entry.shared, true); // camps compartits
  syncEmailConfirmIn(els.sections);
  const blocks = [...document.querySelectorAll(".child-block")];
  selected.forEach((ch, i) => {
    const block = blocks[i]; if (!block) return;
    fillControlsIn(block, ch.data, false);
    syncEmailConfirmIn(block);
    // NO restaurem les setmanes triades altres vegades: cada formulari/campus té les
    // seves pròpies setmanes i dates, i deixar-les marcades porta a confusions (marcar
    // setmanes que no es volen). L'usuari les ha de triar sempre de nou.
  });
  updateAllPrices();
  updateProgress();
  // La nav del wizard s'havia pintat buida dins de renderForm(), abans d'omplir les
  // dades: la refresquem perquè mostri el preu i l'indicador de fills restaurats.
  if (wizardSteps.length) renderWizardNav();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- Helpers ----
function readFileBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("read")); r.readAsDataURL(file); });
}
// Objecte de fitxer tal qual (sense comprimir): per a PDFs i imatges petites.
function readFileObj(file) {
  return readFileBase64(file).then((dataBase64) => ({ name: file.name, mimeType: file.type, dataBase64, size: file.size }));
}
// Reescala/comprimeix imatges abans d'enviar: una foto de mòbil (uns quants MB)
// passa a centenars de KB mantenint-se ben llegible. Així el payload és molt més
// petit i l'enviament (i el processat al servidor) és molt més ràpid.
const IMAGE_MAX_DIM = 1600;   // px del costat llarg
const IMAGE_QUALITY = 0.82;   // qualitat JPEG
function processFileForUpload(file) {
  const t = file.type || "";
  // Només imatges rasteritzables; GIF (pot ser animat) i no-imatges es deixen igual.
  if (!t.startsWith("image/") || t === "image/gif") return readFileObj(file);
  return compressImage(file).catch(() => readFileObj(file)); // si el navegador no la pot descodificar (p.ex. HEIC), s'envia original
}
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(img.width, img.height));
      // Ja és petita i lleugera: no cal recomprimir.
      if (scale === 1 && file.size <= 600 * 1024) return readFileObj(file).then(resolve, reject);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const dataBase64 = canvas.toDataURL("image/jpeg", IMAGE_QUALITY).split(",")[1];
      const size = Math.round(dataBase64.length * 0.75);
      // Si comprimir no ha reduït (imatge ja òptima), conserva l'original.
      if (size >= file.size) return readFileObj(file).then(resolve, reject);
      resolve({
        name: file.name.replace(/\.(png|webp|heic|heif|bmp|tiff?)$/i, ".jpg"),
        mimeType: "image/jpeg", dataBase64, size
      });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img")); };
    img.src = url;
  });
}

// ---- Pujada en segon pla (staging) ----
// En adjuntar una foto, la pugem ja al servidor (carpeta temporal) mentre l'usuari
// acaba el formulari. En enviar, només passem la referència → enviament instantani.
// Si no s'acaba enviant (treure foto / abandonar) s'esborra; i el servidor té TTL.
let submissionDone = false;
function uploadStagedFile(stored, onChange) {
  if (!SCRIPT_URL || !stored || !stored.dataBase64) return; // sense servidor → es queda local (s'enviarà inline)
  stored.status = "uploading";
  if (onChange) onChange();
  const xhr = new XMLHttpRequest();
  stored._xhr = xhr;
  stored._promise = new Promise((resolve) => {
    xhr.open("POST", SCRIPT_URL, true);
    xhr.setRequestHeader("Content-Type", "text/plain;charset=utf-8");
    xhr.onload = () => {
      stored._xhr = null;
      let out = null; try { out = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && out && out.ok && out.fileId) {
        stored.ref = out.fileId; stored.status = "done";
      } else {
        stored.status = "error"; // fallback: s'enviarà inline (base64)
      }
      if (onChange) onChange();
      resolve();
    };
    xhr.onerror = () => { stored._xhr = null; stored.status = "error"; if (onChange) onChange(); resolve(); };
    xhr.onabort = () => { stored._xhr = null; resolve(); };
    xhr.send(JSON.stringify({ action: "upload", form: activeFormId, name: stored.name, mimeType: stored.mimeType, dataBase64: stored.dataBase64 }));
  });
}
function removeStagedFile(stored) {
  if (!stored) return;
  if (stored._xhr) { try { stored._xhr.abort(); } catch (e) {} stored._xhr = null; }
  if (stored.status === "done" && stored.ref) deleteStagedRef(stored.ref);
}
function deleteStagedRef(ref, beacon) {
  if (!SCRIPT_URL || !ref) return;
  const body = JSON.stringify({ action: "delete", form: activeFormId, fileId: ref });
  if (beacon && navigator.sendBeacon) {
    try { navigator.sendBeacon(SCRIPT_URL, new Blob([body], { type: "text/plain;charset=utf-8" })); return; } catch (e) {}
  }
  try { fetch(SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, keepalive: true }); } catch (e) {}
}
// Si s'abandona la pàgina sense enviar, esborra les fotos ja pujades (best-effort).
function cleanupStagedOnUnload() {
  if (submissionDone) return;
  Object.keys(fileStore).forEach((k) => (fileStore[k] || []).forEach((fl) => {
    if (fl && fl.status === "done" && fl.ref) deleteStagedRef(fl.ref, true);
  }));
}
// e.persisted = la pàgina va a bfcache (es pot restaurar) → no esborrem; només
// en tancar o navegar de debò (quan ja no es podrà recuperar el formulari).
window.addEventListener("pagehide", (e) => { if (!e.persisted) cleanupStagedOnUnload(); });
function fmtSize(b) { return b < 1024 * 1024 ? Math.round(b / 1024) + " KB" : (b / 1024 / 1024).toFixed(1) + " MB"; }
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function opt(v, t) { const o = document.createElement("option"); o.value = v; o.textContent = t; return o; }
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function findEmail(data) { if (data.email) return data.email; for (const k in data) if (/email|correu|correo/i.test(k) && /@/.test(data[k])) return data[k]; return ""; }
function pickName(data) {
  const keys = Object.keys(data);
  const nameKey = keys.find((k) => /nom|nombre/i.test(k) && !/tutor|pare|mare|padre|madre/i.test(k));
  const surKey = keys.find((k) => /cognom|apellido/i.test(k));
  return [data[nameKey], data[surKey]].filter(Boolean).join(" ").trim();
}

// ============================================================
// Punts 1–6: progrés · preus en temps real · confetti
// ============================================================

// ---- 1. Indicador de progrés ----
function updateProgress() {
  const progressEl = document.getElementById("form-progress");
  const bar = document.getElementById("form-progress-bar");
  const label = document.getElementById("form-progress-label");
  if (!progressEl || !bar || !label || els.form.hidden) return;

  // La línia inferior només es mostra quan la barra queda enganxada sota el topbar.
  // rootMargin top = -alçada del topbar; quan està fixada, l'IntersectionRatio baixa de 1.
  if (!progressEl.dataset.stickyWatch) {
    progressEl.dataset.stickyWatch = "1";
    new IntersectionObserver(
      ([e]) => progressEl.classList.toggle("is-stuck", e.intersectionRatio < 1),
      { threshold: [1], rootMargin: "-67px 0px 0px 0px" }
    ).observe(progressEl);
  }

  let total = 0, filled = 0;

  els.sections.querySelectorAll(".field[data-required='1']").forEach((wrap) => {
    const c = wrap.querySelector("[data-field]");
    if (!c) return;
    total++;
    if (c.dataset.type === "file") {
      const key = (c.dataset.scope != null && c.dataset.scope !== "")
        ? `c${c.dataset.scope}__${c.dataset.field}` : c.dataset.field;
      if (fileStore[key] && fileStore[key].length) filled++;
    } else if (c.dataset.type === "checkbox" || c.dataset.type === "radio") {
      if (wrap.querySelector("input:checked")) filled++;
    } else {
      if (c.value.trim()) filled++;
    }
  });

  const consentEl = document.getElementById("consent");
  total++;
  if (consentEl && consentEl.checked) filled++;

  if (CONFIG && CONFIG.settings && CONFIG.settings.semanas_obligatorias && weeksForCampus().length) {
    els.sections.querySelectorAll("[data-weeks]").forEach((wrap) => {
      total++;
      if (wrap.querySelector('input[type="checkbox"]:checked')) filled++;
    });
  }

  const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
  progressEl.hidden = filled === 0;
  bar.style.width = pct + "%";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuenow", String(pct));
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");

  if (pct === 100) {
    progressEl.classList.add("is-complete");
    label.textContent = "Tot completat!";
  } else {
    progressEl.classList.remove("is-complete");
    label.textContent = `${filled} de ${total} camps completats`;
  }
  // El botó d'enviar NO es bloqueja: així clicar sempre dona resposta. onSubmit valida,
  // marca els camps que falten i salta al pas del wizard corresponent.
}

// ---- 2. Preus en temps real ----

// Retorna { general1, general2, rdb1, rdb2 } per a una setmana concreta llegint p1/p2/p1_rdb/p2_rdb.
function getWeekPrices(weekId) {
  const w = (CONFIG.weeks || []).find((wk) => wk.id === weekId);
  if (!w || w.p1 == null) return null;
  return { general1: w.p1, general2: w.p2 != null ? w.p2 : w.p1, rdb1: w.p1_rdb != null ? w.p1_rdb : w.p1, rdb2: w.p2_rdb != null ? w.p2_rdb : (w.p2 != null ? w.p2 : w.p1) };
}

function hasPriceConfig() {
  return (CONFIG.weeks || []).some((w) => w.p1 != null);
}

function isChildRDB(childIdx) {
  const block = document.querySelector(`.child-block[data-child="${childIdx}"]`);
  if (!block) return false;
  const cb = block.querySelector("[data-is-rdb]");
  return cb ? cb.checked : false;
}

function isChildFamiliaNombrosa(childIdx) {
  const block = document.querySelector(`.child-block[data-child="${childIdx}"]`);
  if (!block) return false;
  const cb = block.querySelector("[data-is-fn]");
  return cb ? cb.checked : false;
}

// Preu d'una setmana concreta per a un fill concret
// Regles: fill 0 + setmana 0 = preu base; tot la resta = preu reduït
// Família nombrosa: sempre preu reduït (general2), fins i tot la primera setmana
// RDB: escala pròpia (rdb1/rdb2), independent de família nombrosa
function calcWeekPrice(childIdx, weekIdx, isRDB, isFN, prices) {
  const isFirst = childIdx === 0 && weekIdx === 0;
  if (isRDB) {
    return isFirst ? prices.rdb1 : prices.rdb2;
  } else if (isFN) {
    return prices.general2;
  } else {
    return isFirst ? prices.general1 : prices.general2;
  }
}

// Checkbox "Membre de família nombrosa"
// Títol per al grup de descomptes/preus especials (les dues caselles)
function discountsHeadingEl() {
  const wrap = document.createElement("div");
  wrap.className = "field rdb-heading";
  const lab = document.createElement("p");
  lab.className = "field__label";
  lab.textContent = "Descomptes i preus especials";
  const help = document.createElement("p");
  help.className = "field__help";
  help.textContent = "Marca les opcions que us corresponguin per aplicar la tarifa reduïda.";
  wrap.append(lab, help);
  return wrap;
}
function familiaNombrosaCheckboxEl(i) {
  const wrap = document.createElement("div");
  wrap.className = "field rdb-field";
  wrap.dataset.field = "familia_nombrosa"; wrap.dataset.type = "checkbox";
  wrap.dataset.name = `c${i}__familia_nombrosa`; wrap.dataset.scope = String(i);
  const label = document.createElement("label");
  label.className = "rdb-toggle";
  const input = document.createElement("input");
  input.type = "checkbox"; input.id = `fn_c${i}`;
  input.name = `c${i}__familia_nombrosa`; input.value = "Sí"; input.dataset.isFn = "1";
  const box = document.createElement("span");
  box.className = "rdb-toggle__box"; box.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "rdb-toggle__text";
  text.innerHTML = "Membre de <strong>família nombrosa</strong>";
  const badge = document.createElement("span");
  badge.className = "rdb-toggle__badge"; badge.textContent = "Preu especial";
  label.append(input, box, text, badge);
  wrap.appendChild(label);
  return wrap;
}

// Checkbox "Jugador/a del C.P. Riudebitlles" per a cada fill
function rdbCheckboxEl(i) {
  const wrap = document.createElement("div");
  wrap.className = "field rdb-field";
  wrap.dataset.field = "is_rdb"; wrap.dataset.type = "checkbox";
  wrap.dataset.name = `c${i}__is_rdb`; wrap.dataset.scope = String(i);
  const label = document.createElement("label");
  label.className = "rdb-toggle";
  const input = document.createElement("input");
  input.type = "checkbox"; input.id = `rdb_c${i}`;
  input.name = `c${i}__is_rdb`; input.value = "Sí"; input.dataset.isRdb = "1";
  const box = document.createElement("span");
  box.className = "rdb-toggle__box"; box.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "rdb-toggle__text";
  text.innerHTML = "Jugador/a del <strong>C.P. Riudebitlles</strong>";
  const badge = document.createElement("span");
  badge.className = "rdb-toggle__badge"; badge.textContent = "Preu especial";
  label.append(input, box, text, badge);
  wrap.appendChild(label);
  return wrap;
}

// Actualitza el display de preu per a un fill concret
function updateChildPriceDisplay(childIdx) {
  const block = document.querySelector(`.child-block[data-child="${childIdx}"]`);
  const display = block && block.querySelector(".child-price");
  if (!display) return;
  if (!hasPriceConfig()) { display.hidden = true; return; }

  const isRDB = isChildRDB(childIdx);
  const isFN = isChildFamiliaNombrosa(childIdx);
  const selectedWeeks = [...block.querySelectorAll(".weeks input[type='checkbox']:checked")];

  if (!selectedWeeks.length) { display.hidden = true; return; }

  const breakdown = selectedWeeks.map((inp, weekIdx) => calcWeekPrice(childIdx, weekIdx, isRDB, isFN, getWeekPrices(inp.value)));

  const total = breakdown.reduce((s, p) => s + p, 0);
  display.hidden = false;
  display.querySelector(".child-price__amount").textContent = `${total} €`;
  display.querySelector(".child-price__breakdown").textContent =
    breakdown.length > 1 ? `(${breakdown.map((p) => p + " €").join(" + ")})` : "";
}

// Calcula el resum de preus de tots els fills una sola vegada (reutilitzat per la
// targeta del final, el resum de la barra del wizard i el popup de fills).
// Retorna null si no hi ha configuració de preus. `children` inclou tots els blocs
// (amb el seu total individual), `priced` només els que tenen setmanes triades.
function computePriceSummary() {
  if (!hasPriceConfig()) return null;

  const weekConfig = {};
  (CONFIG.weeks || []).forEach((w) => { weekConfig[w.id] = w; });

  const blocks = [...document.querySelectorAll(".child-block")];
  const children = blocks.map((block, childIdx) => {
    const isRDB = isChildRDB(childIdx);
    const isFN = isChildFamiliaNombrosa(childIdx);
    const selectedWeeks = [...block.querySelectorAll(".weeks input[type='checkbox']:checked")];
    const weekBreakdown = selectedWeeks.map((inp, weekIdx) => {
      const wk = weekConfig[inp.value];
      const label = wk ? (wk.fechas ? `${wk.etiqueta} · ${wk.fechas}` : wk.etiqueta) : inp.value;
      return { label, price: calcWeekPrice(childIdx, weekIdx, isRDB, isFN, getWeekPrices(inp.value)) };
    });
    const total = weekBreakdown.reduce((s, w) => s + w.price, 0);
    const titleEl = block.querySelector(".child-block__title");
    const blockTitle = (titleEl && titleEl.textContent.trim()) || `Jugador/a ${childIdx + 1}`;
    const firstTextInput = block.querySelector('input[type="text"]');
    const childName = firstTextInput ? firstTextInput.value.trim() : "";
    const name = childName ? `${blockTitle} · ${childName}` : blockTitle;
    return { name, isRDB, isFN, weekBreakdown, total, childIdx };
  });

  const priced = children.filter((c) => c.weekBreakdown.length > 0);
  const grandTotal = priced.reduce((s, c) => s + c.total, 0);
  return { children, priced, grandTotal, hasMulti: priced.length > 1 };
}

// Actualitza la targeta de resum total de preus
function updateTotalPriceCard() {
  const card = document.getElementById("price-total-card");
  if (!card) return;
  const summary = computePriceSummary();
  if (!summary || !summary.priced.length) { if (card._lastHtml !== "") { card.innerHTML = ""; card._lastHtml = ""; } return; }

  const children = summary.priced;
  const grandTotal = summary.grandTotal;
  const hasMulti = summary.hasMulti;

  const childrenHtml = children.map((c) => {
    const weeksHtml = c.weekBreakdown.map((w) => `
      <div class="price-total__week-row">
        <span class="price-total__week-label">${escapeHtml(w.label)}</span>
        <span class="price-total__week-price">${w.price} €</span>
      </div>`).join("");
    const tags = [];
    if (c.isRDB) tags.push("C.P. Riudebitlles");
    if (c.isFN) tags.push("Família nombrosa");
    if (c.childIdx > 0) tags.push("Germà/na");
    const tagsHtml = tags.length
      ? `<div class="price-total__tags">${tags.map((t) => `<span class="price-total__tag">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    return `
      <div class="price-total__child">
        <div class="price-total__child-hd">
          <span class="price-total__name">${escapeHtml(c.name)}</span>
          <span class="price-total__amount">${c.total} €</span>
        </div>
        ${weeksHtml}
        ${tagsHtml}
      </div>`;
  }).join("");

  const grandHtml = hasMulti ? `
    <div class="price-total__row price-total__row--grand">
      <span class="price-total__name">Total</span>
      <span class="price-total__amount">${grandTotal} €</span>
    </div>` : "";

  const html = `<div class="price-total-card">
    <div class="price-total__header">
      <span class="price-total__icon" aria-hidden="true">€</span>
      <span class="price-total__title">Preu final</span>
    </div>
    ${childrenHtml}${grandHtml}
  </div>`;
  // Evita reparsejar el DOM si el resultat és idèntic (p. ex. en escriure camps que no afecten el preu)
  if (card._lastHtml !== html) {
    // Captura els imports actuals per animar-los cap als nous (comptador premium)
    const prevAmounts = [...card.querySelectorAll(".price-total__amount")]
      .map((el) => parseInt(el.textContent, 10) || 0);
    card.innerHTML = html; card._lastHtml = html;
    const newEls = [...card.querySelectorAll(".price-total__amount")];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Només animem si l'estructura no ha canviat (mateix nombre de files): així evitem salts en afegir/treure fills
    if (!reduce && prevAmounts.length === newEls.length) {
      newEls.forEach((el, i) => {
        const to = parseInt(el.textContent, 10) || 0;
        if (prevAmounts[i] !== to) animateCount(el, prevAmounts[i], to);
      });
    }
  }
}

// Compta suaument un import (€) d'un valor a un altre.
function animateCount(el, from, to) {
  const dur = 440, t0 = performance.now();
  const step = (t) => {
    if (!el.isConnected) return;            // s'ha re-renderitzat: aturem
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);   // ease-out
    el.textContent = `${Math.round(from + (to - from) * eased)} €`;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateAllPrices() {
  const blocks = [...document.querySelectorAll(".child-block")];
  blocks.forEach((_, idx) => updateChildPriceDisplay(idx));
  updateTotalPriceCard();
  renderPcSummary();
}

// ---- Resum lateral d'inscripció (només PC ample, sense wizard) ----
// Equivalent al popup de fills del wizard mòbil: nens apuntats + import detallat,
// però com a panell enganxat (sticky) al costat del formulari.
let _pcSummaryMqlBound = false;
function isPcSummaryLayout() {
  return window.matchMedia("(pointer: fine) and (min-width: 1080px)").matches
    && els.form && !els.form.hidden;
}
// Contenidor de la columna dreta al PC: hi van el "ja t'havíem vist" (a dalt) i el
// rail de resum (sota), com un sol element de la graella → evita repartir l'alçada
// del formulari entre files (que abans empenyia el rail molt avall).
function ensurePcAside() {
  let aside = document.getElementById("pc-aside");
  if (aside) return aside;
  aside = document.createElement("div");
  aside.id = "pc-aside"; aside.className = "pc-aside";
  // El col·loquem on és el "ja t'havíem vist" i l'hi fiquem a dins, perquè al mòbil
  // (sense graella) el banner segueixi sortint a dalt, com sempre.
  if (els.returning && els.returning.parentElement) {
    els.returning.parentElement.insertBefore(aside, els.returning);
    aside.appendChild(els.returning);
  } else if (els.form && els.form.parentElement) {
    els.form.parentElement.insertBefore(aside, els.form);
  }
  return aside;
}
function ensurePcSummaryEl() {
  let el = document.getElementById("pc-summary");
  if (el) return el;
  const aside = ensurePcAside();
  if (!aside) return null;
  el = document.createElement("aside");
  el.id = "pc-summary";
  el.className = "pc-summary";
  el.setAttribute("aria-label", "Resum de la inscripció");
  // Clicar una fila porta al nen corresponent (com al popup del mòbil).
  el.addEventListener("click", (e) => {
    const item = e.target.closest(".pcsum__item");
    if (!item) return;
    const idx = [...el.querySelectorAll(".pcsum__item")].indexOf(item);
    const block = document.querySelectorAll(".child-block")[idx];
    if (block) { expandChild(block); block.scrollIntoView({ behavior: "smooth", block: "start" }); }
  });
  aside.appendChild(el);
  return el;
}
function renderPcSummary() {
  if (!_pcSummaryMqlBound) {
    _pcSummaryMqlBound = true;
    try { window.matchMedia("(pointer: fine) and (min-width: 1080px)").addEventListener("change", renderPcSummary); } catch (e) {}
  }
  const show = isPcSummaryLayout();
  document.body.classList.toggle("pc-summary-on", show);
  const aside = document.getElementById("pc-aside");
  if (!show) {
    // Fora del mode PC: neteja el marge superior que haguéssim aplicat (p.ex. en
    // reduir la finestra), perquè no afecti el layout mòbil.
    if (aside) aside.style.marginTop = "";
    return;
  }
  const el = ensurePcSummaryEl();
  if (!el) return;

  // Alinea el top de la columna dreta amb la primera targeta de secció (no amb la
  // barra de progrés, que viu al capdamunt del formulari i té alçada variable).
  // Mesurem respecte del #form (no sticky) → independent de l'scroll.
  const firstSection = els.form.querySelector(".section");
  const asideEl = document.getElementById("pc-aside");
  if (firstSection && asideEl) {
    const delta = Math.max(0, Math.round(firstSection.getBoundingClientRect().top - els.form.getBoundingClientRect().top));
    asideEl.style.marginTop = delta + "px";
  }

  const summary   = computePriceSummary();
  const dataByIdx = {};
  if (summary) summary.children.forEach((c) => { dataByIdx[c.childIdx] = c; });
  const blocks     = [...document.querySelectorAll(".child-block")];
  const nFilled    = blocks.filter(getChildName).length;
  const grandTotal = summary ? summary.grandTotal : 0;

  const PEOPLE =
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
    `<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`;

  const itemsHtml = blocks.map((block, idx) => {
    const name    = getChildName(block);
    const label   = name || `Jugador/a ${idx + 1}`;
    const filled  = !!name;
    const data    = dataByIdx[idx] || { total: 0, weekBreakdown: [] };
    const amount  = data.total || 0;
    const weeksHtml = data.weekBreakdown.map((w) =>
      `<div class="pcsum__week"><span class="pcsum__week-label">${escapeHtml(w.label)}</span>` +
      `<span class="pcsum__week-price">${w.price} €</span></div>`
    ).join("");
    return `<div class="pcsum__item${filled ? "" : " is-incomplete"}">` +
        `<div class="pcsum__row">` +
          `<span class="pcsum__avatar">${escapeHtml(label.charAt(0).toUpperCase())}</span>` +
          `<span class="pcsum__name">${escapeHtml(label)}</span>` +
          (!filled ? `<span class="pcsum__badge">Incomplet</span>` : "") +
          (amount > 0 ? `<span class="pcsum__amount">${amount} €</span>` : "") +
        `</div>` +
        (weeksHtml ? `<div class="pcsum__weeks">${weeksHtml}</div>` : "") +
      `</div>`;
  }).join("");

  const footHtml = grandTotal > 0
    ? `<div class="pcsum__total"><span class="pcsum__total-label">Total</span>` +
      `<span class="pcsum__amount pcsum__total-amount">${grandTotal} €</span></div>`
    : `<p class="pcsum__hint">Tria les setmanes per veure l'import.</p>`;

  const html =
    `<div class="pcsum__head">` +
      `<span class="pcsum__head-icon" aria-hidden="true">${PEOPLE}</span>` +
      `<span class="pcsum__head-title">La teva inscripció</span>` +
      `<span class="pcsum__count">${nFilled || blocks.length}</span>` +
    `</div>` +
    `<div class="pcsum__body">${itemsHtml}</div>` +
    footHtml;

  if (el._lastHtml === html) return;
  // Anima els imports cap als nous valors (comptador premium), com a la targeta de preus.
  const prev = [...el.querySelectorAll(".pcsum__amount")].map((e) => parseInt(e.textContent, 10) || 0);
  el.innerHTML = html; el._lastHtml = html;
  const next = [...el.querySelectorAll(".pcsum__amount")];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && prev.length === next.length) {
    next.forEach((e, i) => {
      const to = parseInt(e.textContent, 10) || 0;
      if (prev[i] !== to) animateCount(e, prev[i], to);
    });
  }
}

// ---- 3. Confetti (punt 3) ----
function launchConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const COLORS = ["#1F5AE0", "#22c55e", "#FFD600", "#FF6B6B", "#A855F7", "#0EA5E9"];
  const container = document.createElement("div");
  container.className = "confetti-container";
  document.body.appendChild(container);
  for (let i = 0; i < 56; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    const isRect = Math.random() > 0.4;
    piece.style.cssText = [
      `left:${(Math.random() * 100).toFixed(1)}%`,
      `background:${COLORS[Math.floor(Math.random() * COLORS.length)]}`,
      `animation-delay:${(Math.random() * 0.9).toFixed(2)}s`,
      `animation-duration:${(1.4 + Math.random() * 1.4).toFixed(2)}s`,
      `width:${((isRect ? 8 : 7) + Math.random() * 5).toFixed(1)}px`,
      `height:${((isRect ? 4 : 7) + Math.random() * 4).toFixed(1)}px`,
      `border-radius:${isRect ? "2px" : "50%"}`
    ].join(";");
    container.appendChild(piece);
  }
  setTimeout(() => { if (container.parentNode) container.remove(); }, 4000);
}
