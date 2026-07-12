/* ============================================================
   Campus d'Hoquei — Panell d'administració (frontend)

   Es comunica amb el mateix Apps Script que el formulari, però per
   endpoints d'administració protegits per PIN (Ajustes → admin_pin).
   Totes les peticions van per POST amb { action, pin, ... }.

   SCRIPT_URL buit = MODE DEMO amb dades d'exemple generades.
   ============================================================ */

// Si la pestanya Ajustes del full té la clau SCRIPT_URL, s'actualitzarà automàticament.
let SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzhbXl-KTAslBLSHY1l5b5G7CDJYlwXSSrplMgltjRp7JjJ6zGHPRyQGsmIddJVnP6p9w/exec";

const TOKEN_KEY = "casal_admin_token";  // token de sessió UUID (no el PIN)
const VIEW_KEY  = "casal_admin_view2";  // formulari + filtres + ordre desats (v2: ordre per nom per defecte)
const DEMO_PIN  = "1234";

// Colors fixos dels grups (vestidors). Els intervals d'edat són configurables.
const GROUP_HEX = { blau: "#1F5AE0", verd: "#16A34A", taronja: "#D97706", vermell: "#DC2626" };
const GROUP_LABEL = { blau: "Blau", verd: "Verd", taronja: "Taronja", vermell: "Vermell" };
const DEFAULT_GROUPS = [
  { color: "blau", label: "Blau", min: 4, max: 6 },
  { color: "vermell", label: "Vermell", min: 7, max: 9 },
  { color: "taronja", label: "Taronja", min: 10, max: 11 },
  { color: "verd", label: "Verd", min: 12, max: 14 }
];
// Ordre de visualització fix dels grups a tot el panell.
const GROUP_ORDER = ["blau", "vermell", "taronja", "verd"];
function orderGroups(groups) {
  return (groups || []).slice().sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a.color), ib = GROUP_ORDER.indexOf(b.color);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// ---- Estat ----
const state = {
  token: "",
  form: "",
  forms: [],
  overview: null,
  list: [],
  filtered: [],
  sort: { key: "nom", dir: "asc" },   // per defecte: ordenat per nom A→Z
  filters: { q: "", week: "", status: [], group: "", swim: "", from: "", to: "" },   // status: múltiple
  groups: DEFAULT_GROUPS.slice(),
  groupWeek: "",
  selected: new Set(),
  formScope: "active",  // per defecte només dashboard_activo=TRUE · "all" = tots els formularis
  config: null,         // pestanyes de l'Excel de control (pàgina Configuració)
  cfgTab: ""            // pestanya de configuració activa
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Espai indivisible ( ) entre xifra i €: així el símbol no salta mai de línia.
const eur = (n) => `${Math.round(Number(n) || 0).toLocaleString("ca-ES")} €`;
// Normalitza per cercar: minúscules i sense accents (josé → jose).
const DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");
const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(DIACRITICS, "");

document.addEventListener("DOMContentLoaded", init);

function init() {
  // PWA: registra el service worker del panell (instal·lable + càrrega ràpida/offline de la closca).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("admin-sw.js").catch(() => {}));
  }
  $("login-form").addEventListener("submit", onLogin);
  $("logout-btn").addEventListener("click", logout);
  $("refresh-btn").addEventListener("click", () => loadAll(true));
  $("config-btn").addEventListener("click", () => showConfigView($("config-view").hidden));
  $("cfg-close").addEventListener("click", () => showConfigView(false));
  // L'iframe de preview avisa quan ha carregat → li enviem la config del moment.
  window.addEventListener("message", (e) => { if (e.data && e.data.type === "campus-preview-ready") pushPreviewNow(); });
  // Selector de mida de la previsualització (escriptori / mòbil).
  document.querySelectorAll("#cfg-preview-pane .cfg-dev").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#cfg-preview-pane .cfg-dev").forEach((x) => x.classList.toggle("is-active", x === b));
      const stage = $("cfg-preview-stage");
      if (stage) stage.dataset.dev = b.dataset.dev;
      cfgFitPreview();
    }));
  window.addEventListener("resize", () => { clearTimeout(window._cfgFitT); window._cfgFitT = setTimeout(cfgFitPreview, 120); });
  $("form-select").addEventListener("change", (e) => { state.form = e.target.value; state.selected.clear(); saveView(); loadAll(); });
  document.querySelectorAll("#form-scope .form-scope__btn").forEach((b) =>
    b.addEventListener("click", () => setFormScope(b.dataset.scope)));
  const onSearchInput = (e) => { state.filters.q = e.target.value.toLowerCase(); applyFilters(); };
  // "input" cobreix l'escriptura normal; "compositionupdate" fa que també cerqui lletra a lletra
  // amb teclats predictius (Android/Gboard), que d'altra manera no confirmen fins prémer espai.
  $("search").addEventListener("input", onSearchInput);
  $("search").addEventListener("compositionupdate", onSearchInput);
  $("filter-week").addEventListener("change", (e) => { state.filters.week = e.target.value; applyFilters(); });
  // PC: desplegable d'un sol estat. Escriu el mateix model (array) que les pills.
  $("filter-status-sel").addEventListener("change", (e) => {
    state.filters.status = e.target.value ? [e.target.value] : [];
    syncFilterInputs();
    applyFilters();
  });
  // Mòbil: pills de multi-selecció.
  document.querySelectorAll("#filter-status .status-chip").forEach((b) =>
    b.addEventListener("click", () => {
      const arr = state.filters.status;
      const i = arr.indexOf(b.dataset.status);
      if (i >= 0) arr.splice(i, 1); else arr.push(b.dataset.status);
      syncFilterInputs();
      applyFilters();
    }));
  $("filter-group").addEventListener("change", (e) => { state.filters.group = e.target.value; applyFilters(); });
  $("filter-swim").addEventListener("change", (e) => { state.filters.swim = e.target.value; applyFilters(); });
  $("filter-from").addEventListener("change", (e) => { state.filters.from = e.target.value; applyFilters(); });
  $("filter-to").addEventListener("change", (e) => { state.filters.to = e.target.value; applyFilters(); });
  $("clear-filters").addEventListener("click", clearFilters);
  $("filters-toggle").addEventListener("click", toggleFiltersPanel);
  $("export-btn").addEventListener("click", () => exportCsv());
  $("emails-btn").addEventListener("click", exportEmails);
  $("groups-print-btn").addEventListener("click", printRosters);
  $("compare-btn").addEventListener("click", loadComparison);
  $("check-all").addEventListener("change", (e) => toggleSelectAll(e.target.checked));
  $("bulk-bar").querySelectorAll("[data-bulk]").forEach((b) =>
    b.addEventListener("click", () => bulkAction(b.dataset.bulk)));
  $("tabbar").querySelectorAll(".tabbar__btn").forEach((b) =>
    b.addEventListener("click", () => setMobileView(b.dataset.view)));
  const vnav = $("viewnav");
  if (vnav) vnav.querySelectorAll(".viewnav__btn").forEach((b) =>
    b.addEventListener("click", () => setMobileView(b.dataset.view)));
  setMobileView("resum");
  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  document.querySelectorAll(".dtable th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => toggleSort(th.dataset.sort)));

  const saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) { state.token = saved; enter(); }
  else { $("pin").focus(); }
}

// Canvia quina secció del panell es veu (resum / grups / inscrits). El mateix mecanisme
// serveix a escriptori (selector .viewnav) i a mòbil (barra inferior .tabbar): totes dues
// criden aquesta funció, que fixa #dash[data-view] i sincronitza els dos jocs de botons.
function setMobileView(view) {
  const dash = $("dash");
  if (!dash) return;
  dash.dataset.view = view;
  document.querySelectorAll("#tabbar .tabbar__btn, #viewnav .viewnav__btn").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Desa/recupera la vista (formulari + filtres + ordre) perquè un refresc no la perdi.
function saveView() {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ form: state.form, formScope: state.formScope, filters: state.filters, sort: state.sort })); } catch (_) {}
}
function restoreView() {
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
    if (!v) return;
    if (v.formScope === "active" || v.formScope === "all") state.formScope = v.formScope;
    if (v.filters) state.filters = Object.assign({ q: "", week: "", status: [], group: "", swim: "", from: "", to: "" }, v.filters);
    // Compatibilitat amb vistes desades quan l'estat era un sol valor (string).
    if (typeof state.filters.status === "string") state.filters.status = state.filters.status ? [state.filters.status] : [];
    if (!Array.isArray(state.filters.status)) state.filters.status = [];
    if (v.sort && v.sort.key) state.sort = v.sort;
    if (v.form && state.forms.some((f) => f.id === v.form)) state.form = v.form;
  } catch (_) {}
}

// Formularis visibles al selector segons l'àmbit triat ("tots" o "només actius").
// Al dashboard, "actiu" es controla amb el camp "dashboard_activo" (independent de "habilitado",
// que regeix el formulari públic). Si el backend no l'envia, caiem a "habilitado".
function visibleForms() {
  if (state.formScope === "active") {
    const act = state.forms.filter((f) => (f.dashboardActiu != null ? f.dashboardActiu : f.habilitado) !== false);
    return act.length ? act : state.forms;   // si no n'hi ha cap d'actiu, mostra'ls tots
  }
  return state.forms;
}
function renderFormScope() {
  document.querySelectorAll("#form-scope .form-scope__btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.scope === state.formScope));
}
function setFormScope(scope) {
  if (scope !== "all" && scope !== "active") return;
  if (scope === state.formScope) return;
  state.formScope = scope;
  renderFormScope();
  renderFormSelect();
  saveView();
  const vis = visibleForms();
  // Si el formulari obert ja no és visible amb el nou àmbit, en triem el primer.
  if (!vis.some((f) => f.id === state.form)) {
    state.form = vis[0] ? vis[0].id : "";
    $("form-select").value = state.form;
    state.selected.clear();
    saveView();
    loadAll();
  } else {
    $("form-select").value = state.form;
  }
}

// ---- API ----
async function api(action, extra) {
  if (!SCRIPT_URL) return demoApi(action, extra);
  const body = Object.assign({ action, token: state.token, form: state.form }, extra || {});
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
  const out = await res.json();
  if (!out.ok) {
    // "unknown action" = el servidor (Apps Script desplegat) no coneix aquesta acció, és a dir,
    // s'està parlant amb una versió antiga del backend. Missatge clar perquè no sembli un error
    // del panell sinó del desplegament.
    if (String(out.error) === "unknown action")
      throw new Error("el servidor està desactualitzat — torna a desplegar l'Apps Script (mateix desplegament → versió nova)");
    throw new Error(out.error || "error");
  }
  return out;
}

// ---- Login ----
async function onLogin(e) {
  e.preventDefault();
  const pin = $("pin").value.trim();
  if (!pin) return;
  const btn = $("login-btn"); btn.classList.add("is-loading"); btn.disabled = true;
  $("login-note").textContent = "";
  try {
    // El PIN s'envia una sola vegada; el servidor retorna un token UUID de sessió.
    const out = await api("admin_login", { pin });
    if (!out.forms) throw new Error("not-deployed");
    state.token = out.token || "";
    sessionStorage.setItem(TOKEN_KEY, state.token);
    state.forms = out.forms || [];
    if (out.settings && out.settings.SCRIPT_URL) SCRIPT_URL = out.settings.SCRIPT_URL.trim();
    if (out.settings && out.settings.nombre_campus) {
      document.querySelectorAll("[data-camp-name]").forEach((n) => (n.textContent = out.settings.nombre_campus));
    }
    enter();
  } catch (err) {
    state.token = "";
    $("login-note").textContent = err.message === "locked"
      ? "Massa intents fallits. Espera 15 minuts i torna-ho a provar."
      : err.message === "unauthorized"
        ? "Codi incorrecte. Torna-ho a provar."
        : err.message === "not-deployed"
          ? "El servidor encara no té el panell. Publica una versió nova de l'Apps Script."
          : "No s'ha pogut connectar. Comprova la configuració.";
    $("pin").select();
  } finally {
    btn.classList.remove("is-loading"); btn.disabled = false;
  }
}

async function enter() {
  $("login").hidden = true;
  $("app").hidden = false;
  if (!state.forms.length) {
    try { const out = await api("admin_session"); state.forms = out.forms || []; if (out.settings && out.settings.SCRIPT_URL) SCRIPT_URL = out.settings.SCRIPT_URL.trim(); if (out.settings) document.querySelectorAll("[data-camp-name]").forEach((n) => (n.textContent = out.settings.nombre_campus || n.textContent)); }
    catch (err) { return logout(); }
  }
  restoreView();
  renderFormScope();
  renderFormSelect();
  const vis = visibleForms();
  if (!state.form || !vis.some((f) => f.id === state.form)) {
    state.form = vis[0] ? vis[0].id : "";
  }
  $("form-select").value = state.form;
  syncFilterInputs();
  loadAll();
}

// Posa els controls de filtre d'acord amb l'estat (en restaurar la vista o netejar).
function syncFilterInputs() {
  $("search").value = state.filters.q || "";
  const st = Array.isArray(state.filters.status) ? state.filters.status : [];
  document.querySelectorAll("#filter-status .status-chip").forEach((b) =>
    b.classList.toggle("is-active", st.includes(b.dataset.status)));
  const stSel = $("filter-status-sel");
  if (stSel) stSel.value = st.length === 1 ? st[0] : "";   // el desplegable (PC) mostra un sol valor
  $("filter-swim").value = state.filters.swim || "";
  $("filter-from").value = state.filters.from || "";
  $("filter-to").value = state.filters.to || "";
  // week i group depenen de les dades carregades; es posen a renderWeekFilter/renderGroupFilter.
}

function logout() {
  const tok = state.token;
  sessionStorage.removeItem(TOKEN_KEY);
  state.token = "";
  $("app").hidden = true;
  $("login").hidden = false;
  $("pin").value = "";
  $("pin").focus();
  // Invalida el token al servidor (best-effort, sense bloquejar la UI).
  if (tok && SCRIPT_URL) {
    fetch(SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "admin_logout", token: tok }) }).catch(() => {});
  }
}

function renderFormSelect() {
  const sel = $("form-select");
  sel.innerHTML = visibleForms().map((f) => `<option value="${esc(f.id)}">${esc(f.nombre || f.id)}</option>`).join("");
}

// ---- Càrrega de dades ----
async function loadAll(spin) {
  const btn = $("refresh-btn");
  if (spin) btn.classList.add("is-spinning");
  renderKpisSkeleton();
  try {
    let ov, list;
    try {
      const out = await api("admin_data");          // 1 sola petició (ràpid)
      ov = out.overview; list = out.list || [];
      // Refresca quins formularis són actius (dashboard_activo) sense haver de tornar a entrar.
      if (out.forms && out.forms.length) {
        state.forms = out.forms;
        renderFormScope();
        renderFormSelect();
        $("form-select").value = state.form;
      }
    } catch (e1) {
      // Backend antic sense "admin_data": tornem al mètode de 2 peticions.
      if (!/unknown action/i.test(e1.message)) throw e1;
      const [o, l] = await Promise.all([api("admin_overview"), api("admin_list")]);
      ov = o; list = (l && l.rows) || [];
    }
    // Si el backend respon ok però sense estructura de panell, és que l'Apps Script
    // desplegat encara és l'antic (sense els endpoints d'admin). Avisem clarament.
    if (!ov || !ov.kpis) {
      throw new Error("El servidor no respon com a panell. Cal publicar una VERSIÓ NOVA del desplegament de l'Apps Script (Gestiona desplegaments → edita → Versió nova).");
    }
    state.overview = ov;
    state.list = list;
    state.filtered = list.slice();
    // Treu de la selecció els ID que ja no existeixen (canvi de formulari/refresc).
    const ids = new Set(list.map((r) => r.id));
    state.selected.forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
    state.groups = orderGroups((ov.groups && ov.groups.length) ? ov.groups : DEFAULT_GROUPS);
    const cbox = $("compare-box"); if (cbox) { cbox.hidden = true; cbox.innerHTML = ""; cbox.dataset.loaded = ""; }
    renderOverview();
    renderWeekFilter();
    renderGroupFilter();
    applyFilters();
    renderGroups();
  } catch (err) {
    if (err.message === "unauthorized") return logout();
    toast("No s'han pogut carregar les dades: " + err.message, true);
  } finally {
    setTimeout(() => btn.classList.remove("is-spinning"), 400);
  }
}

/* ============================================================
   RENDER — KPIs
   ============================================================ */
function renderKpisSkeleton() {
  $("kpis").innerHTML = Array.from({ length: 4 }, () =>
    `<div class="kpi"><div class="kpi__icon sk" style="background:var(--line-soft)"></div><div class="sk" style="height:30px;width:60%;margin-bottom:8px"></div><div class="sk" style="height:12px;width:80%"></div></div>`
  ).join("");
}

const ICONS = {
  players: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  family: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-3-3.87"/><path d="M4 21v-2a4 4 0 0 1 3-3.87"/><circle cx="12" cy="7" r="4"/></svg>',
  euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.2 7a6 7 0 1 0 0 10"/><path d="M13 10H5"/><path d="M13 14H5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
};

function renderOverview() {
  renderKpis(true);
  renderOccupancy();
  renderTimeline();
  renderPayments();
  renderAges();
  renderDiscounts();
  renderInsights();
}

// animate=true → compte enrere des de 0 (càrrega inicial); false → valor directe
// (actualitzacions, p. ex. en marcar pagat, sense reanimar tot el dashboard).
function renderKpis(animate) {
  const k = state.overview.kpis;
  const cards = [
    { icon: ICONS.players, value: k.jugadors, label: "Jugadors/es inscrits", sub: `${k.enviaments} inscripcions enviades`, accent: "#1F5AE0", soft: "#E5EDFC" },
    { icon: ICONS.family, value: k.families, label: "Famílies", sub: `${k.preu_mitja ? eur(k.preu_mitja) + " de mitjana" : ""}`, accent: "#7C3AED", soft: "#EDE7FB" },
    { icon: ICONS.euro, value: k.ingressos_total, unit: "€", label: "Ingressos totals", sub: `${eur(k.ingressos_cobrats)} cobrats`, accent: "#16A34A", soft: "#DCFCE7", money: true },
    { icon: ICONS.clock, value: k.ingressos_pendents, unit: "€", label: "Pendents de cobrar", sub: `${state.overview.payments.Pendent} pendents${state.overview.payments.Parcial ? " · " + state.overview.payments.Parcial + " parcials" : ""}`, accent: "#D97706", soft: "#FEF3C7", money: true }
  ];
  $("kpis").innerHTML = cards.map((c) => {
    const shown = animate ? "0" : (c.money ? Math.round(c.value).toLocaleString("ca-ES") : Math.round(c.value));
    return `
    <div class="kpi" style="--accent:${c.accent};--accent-soft:${c.soft}">
      <div class="kpi__icon">${c.icon}</div>
      <div class="kpi__value" data-count="${c.value}" data-money="${c.money ? 1 : 0}">${shown}${c.unit ? `<span class="unit">${c.unit}</span>` : ""}</div>
      <div class="kpi__label">${esc(c.label)}</div>
      <div class="kpi__sub">${esc(c.sub)}</div>
    </div>`;
  }).join("");
  if (animate) document.querySelectorAll(".kpi__value[data-count]").forEach((el) => countUp(el));
}

function countUp(el) {
  const target = Number(el.dataset.count) || 0;
  const money = el.dataset.money === "1";
  const unit = el.querySelector(".unit");
  const dur = 750, t0 = performance.now();
  const fmt = (v) => money ? Math.round(v).toLocaleString("ca-ES") : Math.round(v);
  function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.firstChild.textContent = fmt(target * eased);
    if (unit) el.appendChild(unit);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ============================================================
   RENDER — Ocupació per setmana
   ============================================================ */
function renderOccupancy() {
  const weeks = state.overview.weeks || [];
  const groups = state.groups || DEFAULT_GROUPS;
  const box = $("chart-occupancy");
  if (!weeks.length) { box.innerHTML = '<p class="card__hint">Sense setmanes configurades.</p>'; $("occ-hint").textContent = ""; return; }
  const totalInscrits = weeks.reduce((s, w) => s + w.inscrits, 0);
  $("occ-hint").textContent = `${totalInscrits} places ocupades`;

  const legend = `<div class="occ-legend">` + groups.map((g) =>
    `<span class="occ-leg"><span class="occ-leg__dot" style="background:${GROUP_HEX[g.color] || "#94A8C9"}"></span>${esc(g.label)}</span>`
  ).join("") + `</div>`;

  const rows = weeks.map((w) => {
    const hasLimit = w.plazas != null;
    const kids = state.list.filter((r) => (r.weekIds || []).includes(w.id));
    const inscrits = kids.length || w.inscrits;
    const counts = {}; groups.forEach((g) => (counts[g.color] = 0));
    kids.forEach((r) => { const c = groupColorOf(r, w.id); counts[c] = (counts[c] || 0) + 1; });
    const pct = hasLimit && w.plazas > 0 ? Math.min(100, Math.round((inscrits / w.plazas) * 100)) : 0;
    // Base de càlcul de l'amplada: places (si n'hi ha) o el total d'inscrits.
    const basis = hasLimit && w.plazas > 0 ? w.plazas : (inscrits || 1);
    const segs = groups.map((g) => {
      const cnt = counts[g.color] || 0;
      if (!cnt) return "";
      const wdt = Math.min(100, (cnt / basis) * 100);
      return `<span class="occ__seg" data-w="${wdt.toFixed(2)}" style="background:${GROUP_HEX[g.color] || "#94A8C9"}" title="${esc(g.label)}: ${cnt}"></span>`;
    }).join("");
    const countTxt = hasLimit ? `<b>${inscrits}</b> / ${w.plazas}` : `<b>${inscrits}</b> inscrits`;
    return `<div class="occ__row">
      <div class="occ__top">
        <span><span class="occ__name">${esc(w.etiqueta || w.id)}</span> <span class="occ__dates">${esc(w.fechas || "")}</span></span>
        <span class="occ__count">${countTxt}${hasLimit ? ` · ${pct}%` : ""}</span>
      </div>
      <div class="occ__track">${segs}</div>
    </div>`;
  }).join("");

  box.innerHTML = legend + rows;
  requestAnimationFrame(() => box.querySelectorAll(".occ__seg").forEach((s) => (s.style.width = s.dataset.w + "%")));
}

/* ============================================================
   RENDER — Inscripcions per dia (area chart SVG)
   ============================================================ */
// Recompte d'inscripcions per dia a partir d'un conjunt de files (respecta els filtres).
function computePerDay(rows) {
  const m = {};
  (rows || []).forEach((r) => { if (r.ts) m[r.ts] = (m[r.ts] || 0) + 1; });
  return Object.keys(m).sort().map((k) => ({ date: k, count: m[k] }));
}

function renderTimeline() {
  // Es calcula sobre les files filtrades perquè el rang de dates i la resta de
  // filtres es reflecteixin a la corba (no sobre l'agregat fix del servidor).
  const data = computePerDay(state.filtered && state.filtered.length ? state.filtered : state.list);
  const box = $("chart-timeline");
  if (data.length < 2) {
    box.innerHTML = `<p class="card__hint" style="padding:20px 0">${data.length ? "Cal més d'un dia amb inscripcions per dibuixar la tendència." : "Encara no hi ha inscripcions."}</p>`;
    $("timeline-hint").textContent = "";
    return;
  }
  const W = 680, H = 200, padL = 28, padR = 12, padT = 14, padB = 26;
  const max = Math.max(...data.map((d) => d.count), 1);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (innerW * i) / (data.length - 1);
  const y = (v) => padT + innerH - (innerH * v) / max;

  const pts = data.map((d, i) => [x(i), y(d.count)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = `M${padL} ${padT + innerH} ` + pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") + ` L${(padL + innerW).toFixed(1)} ${padT + innerH} Z`;

  const yTicks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const gridLines = yTicks.map((v) => `<line class="grid-line" x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}"/><text class="axis-label" x="0" y="${y(v) + 3}">${v}</text>`).join("");
  const everyN = Math.ceil(data.length / 6);
  const xLabels = data.map((d, i) => (i % everyN === 0 || i === data.length - 1)
    ? `<text class="axis-label" x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtDayShort(d.date)}</text>` : "").join("");
  const dots = pts.map((p, i) => i % everyN === 0 || i === pts.length - 1 ? `<circle class="area-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5"/>` : "").join("");

  $("timeline-hint").textContent = `pic de ${max} en un dia`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1F5AE0" stop-opacity=".28"/>
      <stop offset="100%" stop-color="#1F5AE0" stop-opacity="0"/>
    </linearGradient></defs>
    ${gridLines}
    <path class="area-fill" d="${area}"/>
    <path class="area-line" d="${line}"/>
    ${dots}${xLabels}
  </svg>`;
}
function fmtDayShort(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
}

/* ============================================================
   RENDER — Pagaments (donut)
   ============================================================ */
function renderPayments() {
  const p = state.overview.payments || { Pagat: 0, Parcial: 0, Pendent: 0 };
  const total = (p.Pagat || 0) + (p.Parcial || 0) + (p.Pendent || 0);
  const segs = [
    { name: "Pagat", val: p.Pagat || 0, color: "#16A34A" },
    { name: "Parcial", val: p.Parcial || 0, color: "#1F5AE0" },
    { name: "Pendent", val: p.Pendent || 0, color: "#D97706" }
  ];
  const r = 52, c = 2 * Math.PI * r, cx = 70, cy = 70;
  let offset = 0;
  const circles = total === 0
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EEF3FB" stroke-width="18"/>`
    : segs.filter((s) => s.val > 0).map((s) => {
        const len = (s.val / total) * c;
        const el = `<circle class="donut__seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="butt"/>`;
        offset += len;
        return el;
      }).join("");
  // El centre mostra el % d'INGRESSOS cobrats (no de fitxes), més útil amb pagaments parcials.
  const k = state.overview.kpis || {};
  const pctPaid = k.ingressos_total ? Math.round((k.ingressos_cobrats / k.ingressos_total) * 100) : 0;
  $("chart-payments").innerHTML = `<div class="donut"><svg width="140" height="140" viewBox="0 0 140 140">
    ${circles}
    <g transform="rotate(90 70 70)"><text class="donut__center" x="70" y="70" text-anchor="middle" font-size="26" fill="#0E2A63">${pctPaid}%</text>
    <text x="70" y="90" text-anchor="middle" font-size="11" fill="#5A6B86">cobrat</text></g>
  </svg></div>`;
  $("legend-payments").innerHTML = segs.map((s) =>
    `<li><span class="legend__dot" style="background:${s.color}"></span><span class="legend__name">${s.name}</span><span class="legend__val">${s.val}</span></li>`
  ).join("");
}

/* ============================================================
   RENDER — Edats (bar chart)
   ============================================================ */
function renderAges() {
  const ages = state.overview.ages || [];
  const box = $("chart-ages");
  if (!ages.length) { box.innerHTML = '<p class="card__hint">Sense dades d\'edat.</p>'; return; }
  const max = Math.max(...ages.map((a) => a.count), 1);
  // Cada barra es pinta amb el color del grup que correspon a aquella edat.
  box.innerHTML = ages.map((a) => {
    const hex = GROUP_HEX[autoGroupColor(a.age)] || "#1F5AE0";
    return `<div class="chart-bars__col">
      <div class="chart-bars__bar" data-h="${Math.round((a.count / max) * 100)}" style="background:${hex}"><span class="chart-bars__val">${a.count}</span></div>
      <span class="chart-bars__lbl">${a.age}</span>
    </div>`;
  }).join("");
  requestAnimationFrame(() => box.querySelectorAll(".chart-bars__bar").forEach((b) => (b.style.height = b.dataset.h + "%")));
}

/* ============================================================
   RENDER — Descomptes
   ============================================================ */
function renderDiscounts() {
  const d = state.overview.discounts || {};
  const items = [
    { lbl: "C.P. Riudebitlles", val: d.rdb || 0 },
    { lbl: "Família nombrosa", val: d.fn || 0 },
    { lbl: "2n germà/na", val: d.germa || 0 },
    { lbl: "Tarifa general", val: d.cap || 0 }
  ];
  $("chart-discounts").innerHTML = items.map((i) =>
    `<div class="stat-chip"><span class="stat-chip__val">${i.val}</span><span class="stat-chip__lbl">${esc(i.lbl)}</span></div>`
  ).join("");
}

/* ============================================================
   RENDER — Grups i vestidors
   ============================================================ */
// Color de grup automàtic segons l'edat (intervals configurables).
function autoGroupColor(age) {
  const groups = state.groups || DEFAULT_GROUPS;
  if (age === "" || age == null || isNaN(age)) return groups[0] ? groups[0].color : "";
  for (const g of groups) if (age >= g.min && age <= g.max) return g.color;
  const sorted = groups.slice().sort((a, b) => a.min - b.min);
  return age < sorted[0].min ? sorted[0].color : sorted[sorted.length - 1].color;
}
// Color efectiu d'un nen/a en una setmana: excepció manual o automàtic per edat.
// Si l'excepció desada apunta a un color que ja no és cap grup configurat, l'ignorem i tornem
// a l'automàtic, perquè la fitxa sempre caigui en una columna existent (si no, desapareixeria).
function groupColorOf(row, week) {
  const manual = row.grups && row.grups[week];
  if (manual) {
    const groups = state.groups || DEFAULT_GROUPS;
    if (groups.some((g) => g.color === manual)) return manual;
  }
  return autoGroupColor(Number(row.edat));
}

function renderGroups() {
  const weeks = (state.overview && state.overview.weeks) || [];
  const tabs = $("groups-week-tabs");
  const board = $("groups-board");
  if (!weeks.length) { tabs.innerHTML = ""; board.innerHTML = '<p class="card__hint">Sense setmanes configurades.</p>'; return; }
  if (!state.groupWeek || !weeks.some((w) => w.id === state.groupWeek)) state.groupWeek = weeks[0].id;
  tabs.innerHTML = weeks.map((w) =>
    `<button class="week-tab${w.id === state.groupWeek ? " is-active" : ""}" data-week="${esc(w.id)}">${esc(w.etiqueta || w.id)}</button>`
  ).join("");
  tabs.querySelectorAll("[data-week]").forEach((b) =>
    b.addEventListener("click", () => { state.groupWeek = b.dataset.week; renderGroups(); }));
  renderGroupsBoard();
}

function renderGroupsBoard() {
  const week = state.groupWeek;
  const groups = state.groups || DEFAULT_GROUPS;
  const kids = state.list.filter((r) => (r.weekIds || []).includes(week));
  const byColor = {}; groups.forEach((g) => (byColor[g.color] = []));
  kids.forEach((r) => { const c = groupColorOf(r, week); (byColor[c] = byColor[c] || []).push(r); });

  $("groups-board").innerHTML = groups.map((g) => {
    const list = (byColor[g.color] || []).slice().sort((a, b) => (a.nom || "").localeCompare(b.nom || ""));
    const hex = GROUP_HEX[g.color] || "#64748B";
    const chips = list.map((r) => {
      // El camp de grup sempre està desat; considerem "mogut manualment" només si difereix
      // del grup que li tocaria per edat.
      const manual = !!(r.grups && r.grups[week]) && r.grups[week] !== autoGroupColor(Number(r.edat));
      const noSwim = r.sapNedar && !/^(s|y|1|tru|ok)/i.test(String(r.sapNedar).trim());
      // 🐠 a l'esquerra del nom (si no sap nedar) i l'edat sempre a la dreta.
      const ns = noSwim ? '<span class="gchip__noswim" title="No sap nedar">🐠</span>' : "";
      // Marca discreta (un punt del color del grup) per als moguts manualment.
      const mk = manual ? '<span class="gchip__moved" title="Mogut manualment"></span>' : "";
      // Identifiquem la fitxa per la fila del full (data-row), que és única, i NO per l'ID:
      // dos germans poden compartir ID (mateixa inscripció / mateix mil·lisegon) i això feia
      // que moure'n un mogués sempre l'altre, de manera que no es podien posar al mateix grup.
      // Es mou només arrossegant (ratolí, llapis o dit); ja no hi ha selector de color.
      return `<div class="gchip${manual ? " gchip--manual" : ""}" data-row="${esc(String(r.row))}" title="${manual ? "Mogut manualment · arrossega per moure" : "Assignat per edat · arrossega per moure"}">
        ${mk}${ns}
        <span class="gchip__name" title="${esc(r.nom || "")}">${esc(r.nom || "—")}</span>
        <span class="gchip__age">${r.edat !== "" ? r.edat + "a" : ""}</span>
        <span class="gchip__grip" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span>
      </div>`;
    }).join("");
    const noSwimCount = list.filter((r) => r.sapNedar && !/^(s|y|1|tru|ok)/i.test(String(r.sapNedar).trim())).length;
    const medBadge = noSwimCount ? `<span class="gcol__med" title="No saben nedar">🐠 ${noSwimCount}</span>` : "";
    return `<div class="gcol" data-color="${esc(g.color)}" style="--gc:${hex}">
      <div class="gcol__head"><span class="gcol__dot"></span><span class="gcol__name">${esc(g.label)}</span><span class="gcol__count">${list.length}</span></div>
      <div class="gcol__range"><span>${g.min}–${g.max} anys</span>${medBadge}</div>
      <div class="gcol__list">${chips || '<p class="gcol__empty">Cap nen/a</p>'}</div>
    </div>`;
  }).join("");

  const board = $("groups-board");
  // Arrossegar fitxes entre columnes (ratolí, llapis o dit).
  board.querySelectorAll("[data-row]").forEach((chip) =>
    chip.addEventListener("pointerdown", (e) => onChipPointerDown(e, chip)));
}

// rowNum identifica la fila del full (única). Resolem la inscripció per fila, no per ID,
// perquè germans amb el mateix ID no es trepitgin entre ells.
async function setGroup(rowNum, week, color) {
  const row = state.list.find((r) => String(r.row) === String(rowNum));
  if (!row) return;
  row.grups = row.grups || {};
  // Estat anterior i nou per a aquesta setmana. Una assignació manual SEMPRE es desa com a
  // excepció explícita (per a qualsevol color), encara que coincideixi amb el grup automàtic
  // per edat. Abans, si el color de destí era l'automàtic no es desava res, i això feia que
  // moure un nen/a a un grup que ja era el seu per edat (p. ex. el vermell, 7–9 anys) no
  // quedés mai guardat. Només es treu l'excepció si no arriba cap color.
  const prev = row.grups[week] || "";
  const next = color || "";
  if (prev === next) return;
  if (next) row.grups[week] = next; else delete row.grups[week];
  renderGroupsBoard(); renderOccupancy(); renderTable(); // actualització optimista
  // Enviem la fila (row) perquè el servidor escrigui a la fila exacta; l'id va com a verificació.
  try { await api("admin_set_group", { id: row.id, row: row.row, week, color }); }
  catch (err) { toast("No s'ha pogut moure: " + err.message, true); loadAll(); }
}

/* ---------- Arrossegar per moure de grup (drag & drop) ----------
   Funciona amb ratolí, llapis o dit. Les fitxes tenen touch-action:none (via CSS) perquè
   el gest d'arrossegar no faci desplaçar la pàgina. Mentre s'arrossega, la columna sota el
   punter es marca amb un contorn discontinu; en deixar-la anar, el contorn desapareix. */
let _chipDrag = null;
function onChipPointerDown(e, chip) {
  if (e.button != null && e.button !== 0) return;   // només botó principal
  const rowNum = chip.dataset.row;
  if (!rowNum) return;
  const rect = chip.getBoundingClientRect();
  _chipDrag = {
    rowNum, chip, ghost: null, targetCol: null, moved: false,
    startX: e.clientX, startY: e.clientY,
    offX: e.clientX - rect.left, offY: e.clientY - rect.top, width: rect.width
  };
  window.addEventListener("pointermove", onChipPointerMove);
  window.addEventListener("pointerup", onChipPointerUp, { once: true });
  window.addEventListener("pointercancel", onChipPointerUp, { once: true });
}
function onChipPointerMove(e) {
  const d = _chipDrag; if (!d) return;
  if (!d.moved) {
    // Llindar: distingeix un clic d'un arrossegament real.
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return;
    d.moved = true;
    const ghost = d.chip.cloneNode(true);
    ghost.classList.add("gchip--ghost");
    ghost.style.width = d.width + "px";
    const srcCol = d.chip.closest(".gcol");
    if (srcCol) ghost.style.setProperty("--gc", getComputedStyle(srcCol).getPropertyValue("--gc"));
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.chip.classList.add("gchip--dragging");
    document.body.classList.add("is-dragging-chip");
  }
  e.preventDefault();
  d.ghost.style.left = (e.clientX - d.offX) + "px";
  d.ghost.style.top = (e.clientY - d.offY) + "px";
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const col = under && under.closest(".gcol");
  if (d.targetCol && d.targetCol !== col) d.targetCol.classList.remove("gcol--drop");
  if (col) col.classList.add("gcol--drop");
  d.targetCol = col;
}
function onChipPointerUp() {
  window.removeEventListener("pointermove", onChipPointerMove);
  window.removeEventListener("pointerup", onChipPointerUp);
  window.removeEventListener("pointercancel", onChipPointerUp);
  const d = _chipDrag; _chipDrag = null;
  if (!d) return;
  document.body.classList.remove("is-dragging-chip");
  if (d.ghost) d.ghost.remove();
  d.chip.classList.remove("gchip--dragging");
  if (d.targetCol) {
    d.targetCol.classList.remove("gcol--drop");   // treu el contorn discontinu un cop deixat anar
    if (d.moved && d.targetCol.dataset.color) setGroup(d.rowNum, state.groupWeek, d.targetCol.dataset.color);
  }
}


/* ============================================================
   RENDER — Taula
   ============================================================ */
function renderWeekFilter() {
  const weeks = state.overview.weeks || [];
  const sel = $("filter-week");
  sel.innerHTML = `<option value="">Totes les setmanes</option>` +
    weeks.map((w) => `<option value="${esc(w.id)}">${esc(w.etiqueta || w.id)}</option>`).join("");
  // Si la setmana filtrada ja no existeix (canvi de formulari), netegem el filtre
  // perquè el desplegable i l'estat no quedin desincronitzats.
  if (state.filters.week && !weeks.some((w) => w.id === state.filters.week)) state.filters.week = "";
  sel.value = state.filters.week;
}

function renderGroupFilter() {
  const groups = state.groups || DEFAULT_GROUPS;
  const sel = $("filter-group");
  sel.innerHTML = `<option value="">Tots els grups</option>` +
    groups.map((g) => `<option value="${esc(g.color)}">${esc(g.label)}</option>`).join("");
  if (state.filters.group && !groups.some((g) => g.color === state.filters.group)) state.filters.group = "";
  sel.value = state.filters.group;
}

// Text de cerca que cobreix TOTS els camps de la fila (capçalera + detall).
function rowHaystack(r) {
  const parts = [r.nom, r.tutor, r.email, r.telefon, r.id, r.setmanes, r.descompte, r.estat, r.edat];
  (r.detall || []).forEach((d) => parts.push(d.value));
  return norm(parts.join(" "));
}

function applyFilters() {
  const { q, week, status, group, swim, from, to } = state.filters;
  const nq = norm(q);
  state.filtered = state.list.filter((r) => {
    if (status && status.length && status.indexOf(r.estat) === -1) return false;
    if (week && !(r.weekIds || []).includes(week)) return false;
    if (from && (!r.ts || r.ts < from)) return false;
    if (to && (!r.ts || r.ts > to)) return false;
    if (group) {
      // Si hi ha setmana triada, mirem el grup d'aquella setmana; si no, qualsevol setmana.
      const match = week ? groupColorOf(r, week) === group : (r.weekIds || []).some((w) => groupColorOf(r, w) === group);
      if (!match) return false;
    }
    if (swim) {
      const isSwim = r.sapNedar && /^(s|y|1|tru|ok)/i.test(String(r.sapNedar).trim());
      if (swim === "si" && !isSwim) return false;
      if (swim === "no" && isSwim) return false;
    }
    if (nq && !rowHaystack(r).includes(nq)) return false;
    return true;
  });
  sortRows();
  renderTable();
  renderTimeline();
  updateFilterMeta();
  saveView();
}

// Comptador de resultats + visibilitat del botó "Esborra filtres".
function updateFilterMeta() {
  const f = state.filters;
  const statusActive = Array.isArray(f.status) && f.status.length > 0;
  const active = !!(f.q || f.week || statusActive || f.group || f.swim || f.from || f.to);
  const countEl = $("table-count");
  if (countEl) {
    countEl.hidden = false;
    countEl.textContent = active
      ? `${state.filtered.length} de ${state.list.length} inscripcions`
      : `${state.list.length} inscripcions`;
  }
  const clear = $("clear-filters");
  if (clear) clear.hidden = !active;
  // Comptador de filtres actius (sense la cerca) per al badge del botó de filtres (mòbil)
  const n = ["week", "group", "swim", "from", "to"].filter((k) => f[k]).length + (statusActive ? 1 : 0);
  const badge = $("filters-badge");
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  const tgl = $("filters-toggle");
  if (tgl) tgl.classList.toggle("is-active", n > 0);
}

// Desplega/plega el panell de filtres a mòbil.
function toggleFiltersPanel() {
  const panel = $("filters");
  const open = panel.classList.toggle("is-open");
  $("filters-toggle").setAttribute("aria-expanded", open ? "true" : "false");
}

function clearFilters() {
  state.filters = { q: "", week: "", status: [], group: "", swim: "", from: "", to: "" };
  $("filter-week").value = "";
  $("filter-group").value = "";
  syncFilterInputs();
  applyFilters();
}

function toggleSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  else { state.sort.key = key; state.sort.dir = key === "ts" || key === "preu" ? "desc" : "asc"; }
  sortRows();
  renderTable();
  saveView();
}

function sortRows() {
  const { key, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  state.filtered.sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === "preu") { va = Number(va) || 0; vb = Number(vb) || 0; return (va - vb) * mul; }
    va = String(va || "").toLowerCase(); vb = String(vb || "").toLowerCase();
    return va < vb ? -1 * mul : va > vb ? 1 * mul : 0;
  });
  document.querySelectorAll(".dtable th[data-sort]").forEach((th) => {
    th.classList.toggle("is-sorted", th.dataset.sort === key);
    th.classList.toggle("is-asc", th.dataset.sort === key && dir === "asc");
  });
}

// Icona de rebut (factura) i icona de "rebut ja enviat" (cercle amb ✓).
const RECEIPT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 7h8"/><path d="M8 11h8"/><path d="M8 15h5"/></svg>';
const RECEIPT_SENT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>';

// Indica si ja s'ha enviat el rebut de pagament d'una inscripció. La columna "Rebut enviat"
// de l'Excel és la font de veritat: en enviar-lo es marca a totes les files de la família
// (germans), i si es buida la cel·la a l'Excel (i es refresca el panell) el botó es torna a
// habilitar i es pot reenviar.
function receiptSent(r) {
  return !!(r && r.rebutEnviat);
}

function renderTable() {
  const tbody = $("tbody");
  const rows = state.filtered;
  $("table-empty").hidden = rows.length > 0;
  tbody.innerHTML = rows.map((r, i) => {
    // Cada setmana: fons = color del grup d'aquella setmana; pagada = plena + ✓.
    const pills = (r.weekIds || []).map((w) => {
      const color = groupColorOf(r, w);
      const hex = GROUP_HEX[color] || "#94A8C9";
      const isPaid = (r.paidWeeks || []).includes(w);
      const gl = GROUP_LABEL[color] || color;
      return `<span class="wpill${isPaid ? " wpill--paid" : ""}" style="--wc:${hex}" title="${esc(w)} · ${esc(gl)} · ${isPaid ? "Pagada" : "Pendent"}">${esc(w)}${isPaid ? ' <span class="wpill__chk">✓</span>' : ""}</span>`;
    }).join("");
    // El rebut només té sentit si s'ha cobrat alguna cosa (Pagat o Parcial) i hi ha correu.
    const canReceipt = (r.estat === "Pagat" || r.estat === "Parcial") && r.email;
    const sent = receiptSent(r);
    const receiptBtn = canReceipt
      ? `<button class="iconbtn iconbtn--receipt${sent ? " is-sent" : ""}" data-receipt="${esc(r.id)}"${sent ? " disabled" : ""} title="${sent ? "Rebut de pagament ja enviat" : "Enviar rebut de pagament"}" aria-label="${sent ? "Rebut ja enviat" : "Enviar rebut de pagament"}">${sent ? RECEIPT_SENT_SVG : RECEIPT_SVG}</button>`
      : "";
    return `<tr data-i="${i}">
      <td class="sel-cell"><input type="checkbox" class="row-check" data-check="${esc(r.id)}"${state.selected.has(r.id) ? " checked" : ""} aria-label="Selecciona inscripció"></td>
      <td>${esc(fmtDate(r.ts))}</td>
      <td><div class="cell-name">${esc(r.nom || "—")}</div>${r.edat !== "" ? `<div class="cell-sub">${r.edat} anys</div>` : ""}</td>
      <td>${esc(r.tutor || "—")}<div class="cell-sub">${esc(r.email || "")}</div></td>
      <td><div class="weeks-pills">${pills || "—"}</div></td>
      <td class="num">${r.preu ? eur(r.preu) : "—"}</td>
      <td>${estatBadge(r, true)}</td>
      <td><div class="row-actions">
        ${receiptBtn}
        <button class="iconbtn" data-resend="${esc(r.id)}" title="Reenviar correu" aria-label="Reenviar correu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z" opacity="0"/><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></button>
      </div></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-toggle]") || e.target.closest("[data-resend]") ||
          e.target.closest("[data-receipt]") || e.target.closest("[data-check]")) return;
      openDrawer(state.filtered[Number(tr.dataset.i)]);
    });
  });
  tbody.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleAllPaid(b.dataset.toggle); }));
  tbody.querySelectorAll("[data-resend]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); resend(b.dataset.resend); }));
  tbody.querySelectorAll("[data-receipt]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); sendReceipt(b.dataset.receipt); }));
  tbody.querySelectorAll("[data-check]").forEach((c) =>
    c.addEventListener("change", (e) => { e.stopPropagation(); toggleSelect(c.dataset.check, c.checked); }));

  updateBulkBar();
}

// Etiqueta d'estat de pagament. clickable=true → botó que marca/desmarca totes les setmanes.
function estatBadge(r, clickable) {
  const reg = (r.weekIds || []).length;
  const paid = (r.paidWeeks || []).filter((w) => (r.weekIds || []).includes(w)).length;
  let cls = "estat--pendent", label = "Pendent";
  if (r.estat === "Pagat") { cls = "estat--pagat"; label = "Pagat"; }
  else if (r.estat === "Parcial") { cls = "estat--parcial"; label = `Parcial ${paid}/${reg}`; }
  const attr = clickable ? ` data-toggle="${esc(String(r.row))}" title="Marcar/desmarcar totes les setmanes"` : "";
  const tag = clickable ? "button" : "span";
  return `<${tag} class="estat ${cls}"${attr}><span class="estat__dot"></span>${label}</${tag}>`;
}

function fmtDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/* ============================================================
   Accions de fila
   ============================================================ */
// Operació base: defineix les setmanes pagades d'una fila i refresca el dashboard.
// IMPORTANT: identifiquem la inscripció pel número de fila del full (únic), NO per l'ID:
// dos germans poden compartir ID, i buscar per ID feia que l'actualització optimista toqués
// una fila i el servidor en desés una altra → l'estat no canviava fins al segon clic.
async function setPayment(rowNum, weeks, opts) {
  const row = state.list.find((r) => String(r.row) === String(rowNum));
  if (!row) return;
  // Evita solapaments: si ja hi ha un canvi en vol per a aquesta fila, no en llancem un altre
  // (els clics ràpids es trepitjaven i deixaven l'estat desincronitzat).
  if (row._payBusy) return;
  row._payBusy = true;
  const prev = { paidWeeks: row.paidWeeks, estat: row.estat };
  // Actualització optimista: la UI respon a l'instant; després confirmem amb el servidor.
  const paid = (weeks || []).filter((w) => (row.weekIds || []).includes(w));
  row.paidWeeks = paid;
  row.estat = paid.length === 0 ? "Pendent" : paid.length >= (row.weekIds || []).length ? "Pagat" : "Parcial";
  recomputePayments();
  applyFilters();
  if (opts && opts.reopen && !$("drawer").hidden) openDrawer(row);
  try {
    const out = await api("admin_set_payment", { id: row.id, row: row.row, weeks });
    row.paidWeeks = out.paidWeeks || paid;
    row.estat = out.estat;
    // Re-render amb la veritat del servidor: així, si l'optimista i el servidor difereixen,
    // s'autocorregeix tot sol en lloc d'esperar al següent clic.
    recomputePayments();
    applyFilters();
    if (opts && opts.reopen && !$("drawer").hidden) openDrawer(row);
  } catch (err) {
    row.paidWeeks = prev.paidWeeks; row.estat = prev.estat;
    recomputePayments(); applyFilters();
    if (opts && opts.reopen && !$("drawer").hidden) openDrawer(row);
    toast("No s'ha pogut actualitzar: " + err.message, true);
  } finally {
    row._payBusy = false;
  }
}

// Botó d'estat de la taula: marca totes les setmanes o cap (alterna).
function toggleAllPaid(rowNum, opts) {
  const row = state.list.find((r) => String(r.row) === String(rowNum));
  if (!row) return;
  const reg = (row.weekIds || []);
  const allPaid = reg.length > 0 && reg.every((w) => (row.paidWeeks || []).includes(w));
  setPayment(row.row, allPaid ? [] : reg.slice(), opts);
}

// Alterna una setmana concreta (des del calaix de detall).
function toggleWeekPaid(rowNum, weekId) {
  const row = state.list.find((r) => String(r.row) === String(rowNum));
  if (!row) return;
  const paid = new Set(row.paidWeeks || []);
  paid.has(weekId) ? paid.delete(weekId) : paid.add(weekId);
  setPayment(row.row, [...paid], { reopen: true });
}

function recomputePayments() {
  const o = state.overview; if (!o) return;
  let pagat = 0, parcial = 0, pendent = 0, cobrats = 0, total = 0, ambPreu = 0;
  const families = {}, enviaments = {};
  state.list.forEach((r) => {
    const reg = (r.weekIds || []).length;
    const paid = (r.paidWeeks || []).filter((w) => (r.weekIds || []).includes(w)).length;
    if (r.estat === "Pagat") pagat++;
    else if (r.estat === "Parcial") parcial++;
    else pendent++;
    const preu = Number(r.preu) || 0;
    total += preu;
    if (preu > 0) ambPreu++;
    if (reg) cobrats += preu * (paid / reg);
    if (r.tutor) families[norm(r.tutor)] = true;
    if (r.baseId) enviaments[r.baseId] = true;
  });
  o.payments = { Pagat: pagat, Parcial: parcial, Pendent: pendent };
  // Recalculem també els totals: així es manté coherent en anul·lar inscripcions
  // (en marcar pagaments els totals no canvien, però el càlcul és idempotent).
  o.kpis.jugadors = state.list.length;
  o.kpis.families = Object.keys(families).length;
  o.kpis.enviaments = Object.keys(enviaments).length;
  o.kpis.ingressos_total = Math.round(total);
  o.kpis.preu_mitja = ambPreu ? Math.round(total / ambPreu) : 0;
  o.kpis.ingressos_cobrats = Math.round(cobrats);
  o.kpis.ingressos_pendents = Math.round(total - cobrats);
  renderKpis(false);
  renderPayments();
}

// Refresc complet després d'anul·lar inscripcions (totals, ocupació, grups, taula).
function refreshAfterCancel() {
  recomputePayments();
  renderOccupancy();
  renderInsights();
  applyFilters();
  renderGroups();
}

async function resend(id) {
  const ok = await confirmModal({
    title: "Segur que vols enviar el correu?",
    message: "Es reenviarà el correu de confirmació d'aquesta inscripció.",
    confirmLabel: "Reenvia"
  });
  if (!ok) return;
  try {
    const out = await api("admin_resend", { id });
    toast(out.to ? `Correu reenviat a ${out.to}.` : "Correu reenviat.");
  } catch (err) {
    toast("No s'ha pogut reenviar: " + err.message, true);
  }
}

/* ============================================================
   Confirm modal (pas de seguretat reutilitzable)
   ============================================================ */
function confirmModal({ title, message, confirmLabel = "Confirma", danger = false } = {}) {
  return new Promise((resolve) => {
    const bd = $("confirm-backdrop"), box = $("confirm");
    const ok = $("confirm-ok"), cancel = $("confirm-cancel");
    $("confirm-title").textContent = title || "Confirmar";
    $("confirm-msg").textContent = message || "";
    ok.textContent = confirmLabel;
    ok.classList.toggle("btn--danger", !!danger);
    ok.classList.toggle("btn--primary", !danger);
    bd.hidden = false; box.hidden = false;
    ok.focus();
    function cleanup(val) {
      bd.hidden = true; box.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      bd.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    // Capturem la tecla per evitar que l'Escape global tanqui també el calaix.
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); cleanup(false); }
      else if (e.key === "Enter") { e.stopPropagation(); cleanup(true); }
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    bd.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
  });
}

/* ============================================================
   Recordatoris de pagament (punt 1)
   ============================================================ */
// Envia un recordatori a una inscripció (id) o a un grup d'ids. Sempre demana
// confirmació abans (pas de seguretat contra clics accidentals).
async function remind(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  const targets = list.map((id) => state.list.find((r) => r.id === id)).filter(Boolean);
  // Només té sentit recordar als qui deuen diners i tenen correu.
  const pending = targets.filter((r) => r.estat !== "Pagat" && r.email);
  if (!pending.length) return toast("Cap inscripció amb pagament pendent i correu.", true);

  const msg = pending.length === 1
    ? `S'enviarà un recordatori de pagament a ${pending[0].email}.`
    : `S'enviarà un recordatori de pagament a ${pending.length} famílies amb pagament pendent.`;
  const ok = await confirmModal({ title: "Segur que vols enviar el correu?", message: msg, confirmLabel: "Envia recordatori" });
  if (!ok) return;

  try {
    const out = await api("admin_reminder", { ids: pending.map((r) => r.id) });
    const n = (out && out.sent != null) ? out.sent : pending.length;
    toast(`Recordatori enviat a ${n} ${n === 1 ? "família" : "famílies"}.`);
  } catch (err) {
    toast("No s'ha pogut enviar: " + err.message, true);
  }
}

// Envia un rebut de pagament: un correu que confirma l'import ja pagat pel campus
// (formulari). Té en compte els pagaments parcials (només compta les setmanes pagades).
// El rebut és per família/correu, així que un cop enviat es marquen totes les inscripcions
// que comparteixen aquell correu (germans) i el botó queda deshabilitat.
async function sendReceipt(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  const targets = list.map((id) => state.list.find((r) => r.id === id)).filter(Boolean);
  // Només té sentit enviar rebut a qui ha pagat alguna cosa (Pagat o Parcial) i té correu.
  const payable = targets.filter((r) => (r.estat === "Pagat" || r.estat === "Parcial") && r.email);
  if (!payable.length) return toast("Cap inscripció amb pagament registrat i correu.", true);

  const emails = [...new Set(payable.map((r) => norm(r.email)))];
  const msg = emails.length === 1
    ? `S'enviarà un rebut de pagament a ${payable[0].email}.`
    : `S'enviarà un rebut de pagament a ${emails.length} famílies.`;
  const ok = await confirmModal({ title: "Enviar rebut de pagament?", message: msg, confirmLabel: "Envia rebut" });
  if (!ok) return;

  try {
    const out = await api("admin_receipt", { ids: payable.map((r) => r.id) });
    // Marca com a enviat totes les inscripcions amb un dels correus implicats (germans inclosos).
    const stamp = new Date().toISOString();
    state.list.forEach((r) => { if (r.email && emails.includes(norm(r.email))) r.rebutEnviat = stamp; });
    applyFilters();
    if (!$("drawer").hidden && targets[0]) {
      const fresh = state.list.find((r) => r.id === targets[0].id);
      if (fresh) openDrawer(fresh);
    }
    const n = (out && out.sent != null) ? out.sent : emails.length;
    toast(`Rebut enviat a ${n} ${n === 1 ? "família" : "famílies"}.`);
  } catch (err) {
    toast("No s'ha pogut enviar: " + err.message, true);
  }
}

/* ============================================================
   Selecció múltiple + accions en lot (punt 2)
   ============================================================ */
function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  updateBulkBar();
}
function toggleSelectAll(on) {
  state.filtered.forEach((r) => { if (on) state.selected.add(r.id); else state.selected.delete(r.id); });
  renderTable();
}
function updateBulkBar() {
  const n = state.selected.size;
  const bar = $("bulk-bar");
  if (bar) {
    bar.hidden = n === 0;
    if (n) $("bulk-count").textContent = `${n} seleccionada${n > 1 ? "es" : ""}`;
  }
  const all = $("check-all");
  if (all) {
    const ids = state.filtered.map((r) => r.id);
    const sel = ids.filter((id) => state.selected.has(id)).length;
    all.checked = ids.length > 0 && sel === ids.length;
    all.indeterminate = sel > 0 && sel < ids.length;
  }
}
function selectedRows() {
  return state.list.filter((r) => state.selected.has(r.id));
}

async function bulkAction(kind) {
  const rows = selectedRows();
  if (kind === "clear") { state.selected.clear(); renderTable(); return; }
  if (!rows.length) return;

  if (kind === "remind") return remind(rows.map((r) => r.id));
  if (kind === "export") return exportCsv(rows);

  if (kind === "paid" || kind === "pending") {
    const setPaid = kind === "paid";
    const ok = await confirmModal({
      title: setPaid ? "Marcar com a pagades?" : "Marcar com a pendents?",
      message: `S'aplicarà a ${rows.length} inscripci${rows.length > 1 ? "ons" : "ó"} (totes les setmanes).`,
      confirmLabel: setPaid ? "Marca pagades" : "Marca pendents"
    });
    if (!ok) return;
    for (const r of rows) await setPayment(r.row, setPaid ? (r.weekIds || []).slice() : []);
    toast(`${rows.length} inscripcions actualitzades.`);
    return;
  }

  if (kind === "cancel") {
    const ok = await confirmModal({
      title: "Anul·lar inscripcions?",
      message: `S'arxivaran ${rows.length} inscripci${rows.length > 1 ? "ons" : "ó"} i deixaran de comptar. Aquesta acció no es pot desfer des del panell.`,
      confirmLabel: "Anul·la", danger: true
    });
    if (!ok) return;
    for (const r of rows) await cancelRegistration(r.id, true);
    state.selected.clear();
    refreshAfterCancel();
    toast(`${rows.length} inscripcions anul·lades.`);
    return;
  }
}

/* ============================================================
   Edició / anul·lació d'una inscripció (punt 2)
   ============================================================ */
async function cancelRegistration(id, silent) {
  const idx = state.list.findIndex((r) => r.id === id);
  if (idx < 0) return;
  if (!silent) {
    const ok = await confirmModal({
      title: "Anul·lar aquesta inscripció?",
      message: "S'arxivarà i deixarà de comptar als totals. Aquesta acció no es pot desfer des del panell.",
      confirmLabel: "Anul·la", danger: true
    });
    if (!ok) return;
  }
  const removed = state.list.splice(idx, 1)[0];
  state.selected.delete(id);
  try {
    await api("admin_cancel", { id });
    if (!silent) {
      closeDrawer();
      refreshAfterCancel();
      toast("Inscripció anul·lada.");
    }
  } catch (err) {
    state.list.splice(idx, 0, removed);  // revert
    if (!silent) { applyFilters(); toast("No s'ha pogut anul·lar: " + err.message, true); }
    else throw err;
  }
}

/* ============================================================
   Drawer de detall
   ============================================================ */
// Mostra un valor: si és un (o més) enllaç(os) de fitxer, els pinta com a
// enllaços "Veure document"; si no, text escapat.
function renderDetailValue(value) {
  const s = String(value == null ? "" : value).trim();
  if (/^https?:\/\//.test(s)) {
    const urls = s.split(/[\s\n]+/).filter((u) => /^https?:\/\//.test(u));
    return urls.map((u, i) =>
      `<a href="${esc(u)}" target="_blank" rel="noopener">📎 Veure document${urls.length > 1 ? " " + (i + 1) : ""}</a>`
    ).join("<br>");
  }
  return esc(s);
}

function openDrawer(r) {
  if (!r) return;
  $("drawer-title").textContent = r.nom || "Inscripció";
  const groups = {};
  (r.detall || []).forEach((d) => { (groups[d.grup || "Dades"] = groups[d.grup || "Dades"] || []).push(d); });
  // Rebut de pagament: disponible si s'ha cobrat alguna cosa i hi ha correu; deshabilitat si ja s'ha enviat.
  const canReceipt = (r.estat === "Pagat" || r.estat === "Parcial") && r.email;
  const receiptDone = receiptSent(r);

  let html = "";
  if (r.preu) {
    html += `<div class="drawer__price"><span>Preu${r.descompte && r.descompte !== "-" ? ` · <span style="color:var(--ink-soft);font-size:.85rem">${esc(r.descompte)}</span>` : ""}</span><b>${eur(r.preu)}</b></div>`;
  }
  html += `<div class="dgroup"><div class="dgroup__title">Inscripció</div>
    <div class="dfield"><span class="dfield__k">Referència</span><span class="dfield__v">${esc(r.id)}</span></div>
    <div class="dfield"><span class="dfield__k">Data</span><span class="dfield__v">${esc(fmtDate(r.ts))}</span></div>
    <div class="dfield"><span class="dfield__k">Formulari</span><span class="dfield__v">${esc(r.formulario || "—")}</span></div>
    <div class="dfield"><span class="dfield__k">Estat</span><span class="dfield__v">${estatBadge(r, false)}</span></div>
  </div>`;

  // ── Pagaments per setmana ──
  if ((r.weekIds || []).length) {
    const metaById = {};
    ((state.overview && state.overview.weeks) || []).forEach((w) => (metaById[w.id] = w));
    const paidSet = new Set(r.paidWeeks || []);
    const allPaid = r.weekIds.every((w) => paidSet.has(w));
    html += `<div class="dgroup"><div class="dgroup__title">Pagaments per setmana</div>
      <div class="pay-actions">
        <button class="btn btn--ghost btn--sm" data-payall>${allPaid ? "Desmarcar totes" : "Marcar totes pagades"}</button>
        ${canReceipt ? `<button class="btn btn--ghost btn--sm dw-receipt${receiptDone ? " is-sent" : ""}" id="dw-receipt"${receiptDone ? " disabled" : ""} title="${receiptDone ? "Rebut de pagament ja enviat" : "Enviar rebut de pagament al correu de la família"}">${receiptDone ? "Rebut enviat ✓" : "Enviar rebut"}</button>` : ""}
      </div>
      <div class="pay-weeks">` +
      r.weekIds.map((wid) => {
        const meta = metaById[wid] || {};
        const isPaid = paidSet.has(wid);
        return `<div class="pay-week">
          <span class="pay-week__lbl"><b>${esc(meta.etiqueta || wid)}</b>${meta.fechas ? `<span class="cell-sub"> · ${esc(meta.fechas)}</span>` : ""}</span>
          <button class="estat ${isPaid ? "estat--pagat" : "estat--pendent"}" data-payweek="${esc(wid)}"><span class="estat__dot"></span>${isPaid ? "Pagat" : "Pendent"}</button>
        </div>`;
      }).join("") +
      `</div></div>`;
  }

  Object.keys(groups).forEach((g) => {
    html += `<div class="dgroup"><div class="dgroup__title">${esc(g)}</div>` +
      groups[g].map((d) =>
        `<div class="dfield"><span class="dfield__k">${esc(d.label)}</span><span class="dfield__v">${renderDetailValue(d.value)}</span></div>`
      ).join("") + `</div>`;
  });

  html += `<div class="drawer__actions">
    <button class="btn btn--ghost btn--sm" id="dw-resend">Reenviar correu</button>
    <button class="btn btn--ghost btn--sm" id="dw-editchild">Edita nen/a</button>
  </div>`;

  $("drawer-body").innerHTML = html;
  const payAll = $("drawer-body").querySelector("[data-payall]");
  if (payAll) payAll.addEventListener("click", () => toggleAllPaid(r.row, { reopen: true }));
  $("drawer-body").querySelectorAll("[data-payweek]").forEach((b) =>
    b.addEventListener("click", () => toggleWeekPaid(r.row, b.dataset.payweek)));
  $("dw-resend").addEventListener("click", () => resend(r.id));
  const dwReceipt = $("dw-receipt");
  if (dwReceipt && !receiptDone) dwReceipt.addEventListener("click", () => sendReceipt(r.id));
  $("dw-editchild").addEventListener("click", () => openEditChild(r));

  $("drawer-backdrop").hidden = false;
  $("drawer").hidden = false;
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawer-backdrop").hidden = true;
}

/* ============================================================
   Edició completa d'una inscripció ("Edita nen/a")
   ============================================================ */
// Converteix un valor de data del full (ISO, dd/mm/aaaa o Date en text) al
// format que necessita un <input type="date">. Buit si no s'entén.
function toISODateInput(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return "";
}

// L'input adequat per a cada camp del detall. Els fitxers (i valors amb URL)
// no s'editen des d'aquí: es mostren com al mode lectura.
function editControlFor(d) {
  const val = String(d.value == null ? "" : d.value);
  if (!d.id || d.tipo === "file" || /^https?:\/\//.test(val.trim())) return renderDetailValue(d.value);
  const fid = esc(d.id);
  if (d.tipo === "select" || d.tipo === "radio") {
    const opts = (d.opciones || "").split("|").map((s) => s.trim()).filter(Boolean);
    if (val && !opts.includes(val)) opts.unshift(val);
    if (opts.length) {
      return `<select class="dedit" data-fid="${fid}" data-orig="${esc(val)}">` +
        opts.map((o) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`).join("") +
      `</select>`;
    }
  }
  if (d.tipo === "textarea") return `<textarea class="dedit" data-fid="${fid}" data-orig="${esc(val)}" rows="3">${esc(val)}</textarea>`;
  if (d.tipo === "date") {
    const iso = toISODateInput(val);
    if (iso) return `<input type="date" class="dedit" data-fid="${fid}" value="${iso}" data-orig="${iso}">`;
  }
  const t = d.tipo === "email" ? "email" : d.tipo === "tel" ? "tel" : d.tipo === "number" ? "number" : "text";
  return `<input type="${t}" class="dedit" data-fid="${fid}" value="${esc(val)}" data-orig="${esc(val)}">`;
}

// Re-pinta el calaix en mode edició: la mateixa plantilla del detall, però amb
// cada valor convertit en un control. Res no es desa fins a "Desa els canvis".
function openEditChild(r) {
  $("drawer-title").textContent = `Editant · ${r.nom || "inscripció"}`;
  const groups = {};
  (r.detall || []).forEach((d) => { (groups[d.grup || "Dades"] = groups[d.grup || "Dades"] || []).push(d); });
  const weeksCfg = (state.overview && state.overview.weeks) || [];
  const current = new Set(r.weekIds || []);
  const paidSet = new Set(r.paidWeeks || []);

  let html = `<p class="edit-banner">Mode edició — no es desa res fins que cliquis «Desa els canvis».</p>`;

  html += `<div class="dgroup"><div class="dgroup__title">Preu</div>
    <div class="dfield"><span class="dfield__k">Preu total (€)</span><span class="dfield__v"><input type="number" class="dedit" id="ec-preu" min="0" step="1" value="${r.preu != null ? esc(String(r.preu)) : ""}" data-orig="${r.preu != null ? esc(String(r.preu)) : ""}"></span></div>
    <div class="dfield"><span class="dfield__k">Descompte</span><span class="dfield__v"><input type="text" class="dedit" id="ec-descompte" value="${esc(r.descompte && r.descompte !== "-" ? r.descompte : "")}" data-orig="${esc(r.descompte && r.descompte !== "-" ? r.descompte : "")}" placeholder="—"></span></div>
  </div>`;

  if (weeksCfg.length) {
    const items = weeksCfg.map((w) => {
      const occupied = state.list.filter((x) => (x.weekIds || []).includes(w.id)).length;
      const full = w.plazas != null && w.plazas > 0 && occupied >= w.plazas && !current.has(w.id);
      const occTxt = w.plazas != null && w.plazas > 0 ? `${occupied}/${w.plazas}` : `${occupied}`;
      return `<label class="wk-edit${full ? " wk-edit--full" : ""}">
        <input type="checkbox" data-wk="${esc(w.id)}"${current.has(w.id) ? " checked" : ""}>
        <span class="wk-edit__lbl"><b>${esc(w.etiqueta || w.id)}</b>${w.fechas ? `<span class="cell-sub"> · ${esc(w.fechas)}</span>` : ""}${paidSet.has(w.id) ? ` <span class="wk-edit__paid">pagada</span>` : ""}</span>
        <span class="wk-edit__occ${full ? " is-full" : ""}">${full ? "plena · " : ""}${occTxt}</span>
      </label>`;
    }).join("");
    html += `<div class="dgroup"><div class="dgroup__title">Setmanes</div>
      <div class="wk-edit-list">${items}</div>
      <p class="wk-edit-hint">El preu no es recalcula sol (descomptes de germans, club…): revisa'l si canvies setmanes. Si es treu una setmana ja pagada, deixarà de comptar com a cobrada.</p>
    </div>`;
  }

  Object.keys(groups).forEach((g) => {
    html += `<div class="dgroup"><div class="dgroup__title">${esc(g)}</div>` +
      groups[g].map((d) =>
        `<div class="dfield dfield--edit"><span class="dfield__k">${esc(d.label)}</span><span class="dfield__v">${editControlFor(d)}</span></div>`
      ).join("") + `</div>`;
  });

  html += `<div class="drawer__editactions">
    <button class="btn btn--primary" id="ec-save">Desa els canvis</button>
    <button class="btn btn--ghost" id="ec-cancel">Cancel·la</button>
  </div>`;

  $("drawer-body").innerHTML = html;
  $("ec-cancel").addEventListener("click", () => openDrawer(r));
  $("ec-save").addEventListener("click", () => saveChildEdit(r.row));
}

async function saveChildEdit(rowNum) {
  const row = state.list.find((r) => String(r.row) === String(rowNum));
  if (!row) return;
  const body = $("drawer-body");

  // Camps del formulari: només els que han canviat respecte del valor original.
  const patch = {};
  body.querySelectorAll(".dedit[data-fid]").forEach((el) => {
    if (el.value !== el.dataset.orig) patch[el.dataset.fid] = el.value.trim();
  });
  const preuEl = $("ec-preu"), descEl = $("ec-descompte");
  const preuChanged = preuEl && preuEl.value !== preuEl.dataset.orig;
  const descChanged = descEl && descEl.value !== descEl.dataset.orig;
  const preu = preuChanged ? Math.max(0, Number(preuEl.value) || 0) : null;
  const descompte = descChanged ? (descEl.value.trim() || "-") : null;

  // Setmanes: comparem la selecció amb la inscripció actual.
  const wkBoxes = [...body.querySelectorAll("[data-wk]")];
  let selected = null;
  if (wkBoxes.length) {
    selected = wkBoxes.filter((c) => c.checked).map((c) => c.dataset.wk);
    if (!selected.length) return toast("Cal deixar almenys una setmana. Per donar de baixa la inscripció, fes servir Anul·la.", true);
    const same = selected.length === (row.weekIds || []).length && selected.every((w) => (row.weekIds || []).includes(w));
    if (same) selected = null;   // sense canvis de setmanes
  }

  if (!Object.keys(patch).length && !preuChanged && !descChanged && !selected) return toast("No hi ha canvis.");

  // Avisa si s'afegeix una setmana plena (l'admin pot forçar-ho igualment).
  if (selected) {
    const weeksCfg = (state.overview && state.overview.weeks) || [];
    const overbooked = selected.filter((wid) => {
      if ((row.weekIds || []).includes(wid)) return false;
      const w = weeksCfg.find((x) => x.id === wid);
      if (!w || w.plazas == null || !(w.plazas > 0)) return false;
      return state.list.filter((x) => (x.weekIds || []).includes(wid)).length >= w.plazas;
    });
    if (overbooked.length) {
      const names = overbooked.map((wid) => { const w = weeksCfg.find((x) => x.id === wid); return (w && w.etiqueta) || wid; }).join(", ");
      const ok = await confirmModal({
        title: "Setmana plena",
        message: `${names} ja té totes les places ocupades. Vols inscriure-hi el jugador/a igualment?`,
        confirmLabel: "Sí, afegeix igualment"
      });
      if (!ok) return;
    }
  }

  const saveBtn = $("ec-save");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Desant…"; }
  try {
    if (Object.keys(patch).length || preuChanged || descChanged) {
      const out = await api("admin_update_fields", { id: row.id, row: row.row, patch, preu, descompte });
      // Valors editats → al detall local; derivats (nom, edat…) → del servidor.
      (row.detall || []).forEach((d) => { if (d.id && patch[d.id] != null) d.value = patch[d.id]; });
      if (out.nom) row.nom = out.nom;
      if (out.tutor != null) row.tutor = out.tutor;
      if (out.email != null) row.email = out.email;
      if (out.telefon != null) row.telefon = out.telefon;
      if (out.edat !== "" && out.edat != null) row.edat = out.edat;
      if (out.preu != null) row.preu = out.preu;
      if (out.descompte != null) row.descompte = out.descompte;
    }
    if (selected) {
      const out2 = await api("admin_set_weeks", { id: row.id, row: row.row, weeks: selected });
      row.weekIds = out2.weekIds || selected;
      if (out2.setmanes) row.setmanes = out2.setmanes;
      row.paidWeeks = out2.paidWeeks || (row.paidWeeks || []).filter((w) => selected.includes(w));
      if (out2.estat) row.estat = out2.estat;
    }
    recomputePayments();
    renderOccupancy();
    renderAges();
    applyFilters();
    openDrawer(row);
    toast("Canvis desats.");
  } catch (err) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Desa els canvis"; }
    toast("No s'ha pogut desar: " + err.message, true);
  }
}

/* ============================================================
   Configuració dels formularis (GUI amable sobre l'Excel de control)
   ------------------------------------------------------------
   Estructura: la pàgina principal mostra ELS FORMULARIS (els 4 campus de
   l'any) com a targetes amb els interruptors essencials; "Edita el contingut"
   obre un editor NOMÉS d'aquell formulari (setmanes + textos junts), de
   manera que mai veus files d'altres formularis ni pots tocar el que no toca.
   El model en memòria segueix sent l'Excel tal qual ({header, rows} per
   pestanya): cap columna ni clau desconeguda es perd en desar.
   ============================================================ */
const CFG_SHEET_NAMES = ["Formularios", "Semanas", "Ajustes", "Campos"];
// Capçaleres proposades quan una pestanya encara no existeix o és buida.
const CFG_DEFAULT_HEADERS = {
  Formularios: ["id", "nombre", "habilitado", "dashboard_activo", "hoja"],
  Semanas: ["id", "etiqueta", "fechas", "plazas", "precio", "precio_dto", "precio_rdb", "precio_rdb_dto", "form"],
  Ajustes: ["Clave", "Valor", "form"],
  Campos: ["id", "etiqueta", "tipo", "opciones", "obligatorio", "placeholder", "ayuda", "grupo", "orden", "form"]
};

// Tipus de pregunta amb noms humans (el valor és el que s'escriu a l'Excel).
const CFG_TIPOS = [
  ["text", "Text curt"], ["textarea", "Text llarg"], ["email", "Correu electrònic"],
  ["tel", "Telèfon"], ["number", "Número"], ["date", "Data"],
  ["select", "Desplegable"], ["radio", "Opcions (tria'n una)"], ["checkbox", "Caselles (tria'n vàries)"],
  ["file", "Fitxer adjunt"], ["nota", "Nota informativa (sense resposta)"]
];
const CFG_TIPO_COLOR = {
  text: "#475569", textarea: "#475569", email: "#0E7490", tel: "#0E7490", number: "#0E7490",
  date: "#B45309", select: "#7C3AED", radio: "#7C3AED", checkbox: "#7C3AED", file: "#16A34A", nota: "#64748B"
};

// Ajustos coneguts: etiqueta i explicació humanes. scope "general" = només
// s'edita des del contingut compartit (no té sentit personalitzar-los per formulari).
const CFG_SETTINGS_META = {
  nombre_campus: { label: "Nom del campus", help: "Surt al capdamunt del web i al panell.", group: "General", scope: "general" },
  club: { label: "Lema del club", help: "Text petit sota el nom (p. ex. «El plaer de jugar!»).", group: "General", scope: "general" },
  lema: { label: "Etiqueta de portada", help: "El text petit sobre el títol (p. ex. «Inscripcions obertes»).", group: "Portada" },
  hero_titulo: { label: "Títol principal", help: "El títol gran de la portada. Els salts de línia es respecten.", long: true, group: "Portada" },
  intro: { label: "Text d'introducció", help: "El paràgraf sota el títol.", long: true, group: "Portada" },
  hero_dates: { label: "Xip de dates", help: "P. ex. «29 juny – 31 juliol». Buit = no surt.", group: "Portada" },
  hero_horari: { label: "Xip d'horari", help: "P. ex. «9 – 13 h». Buit = no surt.", group: "Portada" },
  hero_edats: { label: "Xip d'edats", help: "P. ex. «De 4 a 16 anys». Buit = no surt.", group: "Portada" },
  hero_lloc: { label: "Xip de lloc", help: "P. ex. «Sant Pere de Riudebitlles». Buit = no surt.", group: "Portada" },
  setmanes_titulo: { label: "Títol de la secció de setmanes", group: "Setmanes" },
  setmanes_info: { label: "Nota de preus", help: "Text sota el títol de setmanes explicant preus i descomptes.", long: true, group: "Setmanes" },
  semanas_obligatorias: { label: "Cal triar almenys una setmana", bool: true, group: "Setmanes" },
  texto_boton: { label: "Text del botó d'enviar", group: "Formulari" },
  consentimiento: { label: "Text del consentiment", help: "La casella de protecció de dades que cal acceptar.", long: true, group: "Formulari" },
  mensaje_exito: { label: "Missatge d'inscripció rebuda", long: true, group: "Confirmació" },
  instruccions_pagament: { label: "Instruccions de pagament", help: "Surt a la pantalla d'èxit, sota el resum. Salts de línia respectats.", long: true, group: "Confirmació" },
  email_contacto: { label: "Correu de contacte", help: "On respondran les famílies.", group: "Correu" },
  email_asunto: { label: "Assumpte del correu de confirmació", group: "Correu" },
  email_intro: { label: "Introducció del correu", long: true, group: "Correu" },
  grups_edats: { label: "Grups per edats", help: "Format: blau:4-6; vermell:7-9; taronja:10-11; verd:12-14", group: "Avançat", scope: "general" },
  carpeta_fitxers: { label: "Carpeta de fitxers al Drive", help: "On es guarden les targetes sanitàries adjuntades.", group: "Avançat", scope: "general" },
  admin_pin: { label: "PIN d'accés al panell", help: "Si el canvies, el proper login demanarà el nou.", group: "Avançat", scope: "general" },
  SCRIPT_URL: { label: "URL del servidor (Apps Script)", help: "No la toquis si tot funciona.", group: "Avançat", scope: "general" }
};
// Grups d'ajustos, EN L'ORDRE EN QUÈ APAREIXEN AL FORMULARI (portada → setmanes →
// botó → confirmació → correu → general/avançat), amb icona i títol de panell.
// "Setmanes" no és un panell propi: aquestes claus s'integren al panell de setmanes.
const CFG_GROUPS = [
  { name: "Portada", icon: "🖼️", title: "Portada" },
  { name: "Formulari", icon: "📝", title: "Botó i consentiment" },
  { name: "Confirmació", icon: "✅", title: "Pantalla de confirmació" },
  { name: "Correu", icon: "✉️", title: "Correu de confirmació" },
  { name: "General", icon: "🏫", title: "Dades generals" },
  { name: "Avançat", icon: "🛠️", title: "Avançat" },
  { name: "Altres ajustos", icon: "🔧", title: "Altres ajustos" }
];

// Estació d'un formulari (columna estacio o deduïda del nom) → emoji + color.
const CFG_SEASONS = {
  estiu: { emoji: "☀️", color: "#F59E0B", label: "Estiu" },
  tardor: { emoji: "🍂", color: "#C2410C", label: "Tardor / Setembre" },
  hivern: { emoji: "❄️", color: "#2563EB", label: "Hivern / Nadal" },
  primavera: { emoji: "🌼", color: "#16A34A", label: "Primavera" },
  "": { emoji: "🏑", color: "#0E2A63", label: "Automàtica (segons el nom)" }
};
// Identificador automàtic a partir del nom: estació (o primera paraula útil) + any.
function cfgSlugId(name) {
  const t = String(name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const season = (t.match(/estiu|setembre|tardor|nadal|hivern|primavera|pasqua/) || [])[0] || "";
  const yy = (t.match(/20(\d{2})/) || [])[1] || "";
  let base = season;
  if (!base) {
    base = t.replace(/[^a-z0-9 ]/g, "").split(/\s+/)
      .find((w) => w && !["campus", "casal", "de", "del", "d", "el", "la"].includes(w) && !/^\d+$/.test(w)) || "";
  }
  return base ? base + yy : "";
}

// Any d'un formulari (del nom, l'id o la pestanya) per ordenar-los cronològicament.
function cfgYearOf(sheet, row) {
  const t = cfgRowGet(sheet, row, "nombre") + " " + cfgRowGet(sheet, row, "id") + " " + cfgRowGet(sheet, row, "hoja");
  const m = t.match(/20(\d{2})/);
  return m ? Number("20" + m[1]) : 0;
}

function cfgSeasonOf(sheet, row) {
  const s = cfgRowGet(sheet, row, "estacio").trim().toLowerCase();
  if (CFG_SEASONS[s] && s) return s;
  const t = (cfgRowGet(sheet, row, "id") + " " + cfgRowGet(sheet, row, "nombre")).toLowerCase();
  if (/estiu|juliol|agost|verano|summer/.test(t)) return "estiu";
  if (/setembre|tardor|octubre|oto[nñ]/.test(t)) return "tardor";
  if (/nadal|hivern|desembre|gener|invierno/.test(t)) return "hivern";
  if (/primavera|pasqua|abril|maig/.test(t)) return "primavera";
  return "";
}

/* ---- Helpers de model: llegir/escriure per NOM de columna ---- */
function cfgSheet(name) { return state.config && state.config[name]; }
function cfgColIdx(sheet, name) {
  return sheet.header.findIndex((h) => String(h).trim().toLowerCase() === String(name).toLowerCase());
}
function cfgRowGet(sheet, row, name) {
  const i = cfgColIdx(sheet, name);
  return i === -1 || row[i] == null ? "" : String(row[i]);
}
function cfgMarkDirty(sheet) {
  if (!sheet._dirty) { sheet._dirty = true; renderCfgTabs(); }
  sheet._rev = (sheet._rev || 0) + 1;   // per saber si hi ha edicions durant un desat en curs
  scheduleCfgSave();
  schedulePreview();                    // reflecteix el canvi al preview en directe
}
function cfgRowSet(sheet, rIdx, name, val) {
  let i = cfgColIdx(sheet, name);
  if (i === -1) { sheet.header.push(name); i = sheet.header.length - 1; }
  const row = sheet.rows[rIdx];
  while (row.length < sheet.header.length) row.push("");
  row[i] = val;
  cfgMarkDirty(sheet);
}
function cfgNewRow(sheet, values) {
  const row = Array(sheet.header.length).fill("");
  Object.keys(values || {}).forEach((k) => {
    let i = cfgColIdx(sheet, k);
    if (i === -1) { sheet.header.push(k); i = sheet.header.length - 1; }
    while (row.length < sheet.header.length) row.push("");
    row[i] = values[k];
  });
  sheet.rows.push(row);
  cfgMarkDirty(sheet);
  return sheet.rows.length - 1;
}
// TRUE/buit/Sí/1… → booleà, amb valor per defecte quan la cel·la és buida.
function cfgBool(v, dflt) {
  const s = String(v == null ? "" : v).trim();
  if (s === "") return dflt;
  return /^(true|sí|si|x|1|yes)$/i.test(s);
}
// Valor numèric d'una cel·la per a un <input type="number">: l'Excel pot tornar
// el preu FORMATAT ("70,00 €", "1.234,50") i l'input el mostraria buit.
function cfgNumVal(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (s.includes(",")) s = s.replace(/\./g, "").replace(/,/g, ".");   // coma decimal europea
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return "";
  const n = parseFloat(m[0]);
  return isNaN(n) ? "" : String(n);
}
function cfgAnyDirty() { return CFG_SHEET_NAMES.some((n) => cfgSheet(n) && cfgSheet(n)._dirty); }

/* ============================================================
   Previsualització en directe: convertim el model (fulls de l'Excel) al
   format que consumeix el formulari públic (app.js) i l'hi enviem per
   postMessage a un iframe. Rèplica de buildConfig/readSettings/readWeeks/
   readFields del backend, però amb les dades que s'estan editant ara mateix.
   ============================================================ */
function cfgTruthy(v) { return /^(true|sí|si|x|1|yes)$/i.test(String(v == null ? "" : v).trim()); }
function cfgNum(v) { const s = cfgNumVal(v); return s === "" ? null : Number(s); }
function cfgRowScopeMatches(sheet, row, formId) {
  const f = cfgRowGet(sheet, row, "form").trim();
  return f === "" || f === formId;   // buit = compartida; igual a l'id = pròpia
}
function cfgDefaultFormId() {
  const fs = cfgSheet("Formularios");
  if (!fs || !fs.rows.length) return "";
  for (const row of fs.rows) if (cfgBool(cfgRowGet(fs, row, "habilitado"), true)) return cfgRowGet(fs, row, "id").trim();
  return cfgRowGet(fs, fs.rows[0], "id").trim();
}
function cfgPreviewSettings(formId) {
  const as = cfgSheet("Ajustes");
  const out = {};
  // General primer (form buit), després sobreescriu amb les del formulari.
  as.rows.forEach((row) => { if (cfgRowGet(as, row, "form").trim() === "") { const k = cfgRowGet(as, row, "Clave").trim(); if (k) out[k] = cfgRowGet(as, row, "Valor"); } });
  as.rows.forEach((row) => { if (cfgRowGet(as, row, "form").trim() === formId) { const k = cfgRowGet(as, row, "Clave").trim(); if (k) out[k] = cfgRowGet(as, row, "Valor"); } });
  return out;
}
function cfgPreviewWeeks(formId) {
  const ws = cfgSheet("Semanas");
  return ws.rows.filter((row) => cfgRowGet(ws, row, "id").trim() && cfgRowScopeMatches(ws, row, formId)).map((row) => {
    const p1 = cfgNum(cfgRowGet(ws, row, "precio"));
    const p2 = cfgNum(cfgRowGet(ws, row, "precio_dto"));
    const p1r = cfgNum(cfgRowGet(ws, row, "precio_rdb"));
    const p2r = cfgNum(cfgRowGet(ws, row, "precio_rdb_dto"));
    const plazas = cfgNum(cfgRowGet(ws, row, "plazas"));
    const w = {
      id: cfgRowGet(ws, row, "id").trim(), etiqueta: cfgRowGet(ws, row, "etiqueta"), fechas: cfgRowGet(ws, row, "fechas"),
      mostrar_plazas: cfgRowGet(ws, row, "mostrar_plazas"), precio: cfgRowGet(ws, row, "precio"),
      p1: p1, p2: p2 != null ? p2 : p1, p1_rdb: p1r != null ? p1r : p1, p2_rdb: p2r != null ? p2r : (p2 != null ? p2 : p1)
    };
    if (plazas != null) { w.plazas = plazas; w.plazas_restantes = plazas; }
    return w;
  });
}
function cfgPreviewFields(formId) {
  const cs = cfgSheet("Campos");
  return cs.rows.filter((row) => cfgRowGet(cs, row, "id").trim() && cfgRowScopeMatches(cs, row, formId)).map((row) => ({
    id: cfgRowGet(cs, row, "id").trim(), etiqueta: cfgRowGet(cs, row, "etiqueta"),
    tipo: cfgRowGet(cs, row, "tipo").trim() || "text", opciones: cfgRowGet(cs, row, "opciones"),
    obligatorio: cfgTruthy(cfgRowGet(cs, row, "obligatorio")), placeholder: cfgRowGet(cs, row, "placeholder"),
    ayuda: cfgRowGet(cs, row, "ayuda"), grupo: cfgRowGet(cs, row, "grupo") || "Inscripció",
    orden: cfgNum(cfgRowGet(cs, row, "orden")) || 0
  })).sort((a, b) => a.orden - b.orden);
}
function cfgBuildPreviewConfig(formId) {
  const fs = cfgSheet("Formularios");
  let formRow = null;
  if (fs) fs.rows.forEach((row) => { if (cfgRowGet(fs, row, "id").trim() === formId) formRow = row; });
  const form = formRow
    ? { id: formId, nombre: cfgRowGet(fs, formRow, "nombre"), habilitado: cfgBool(cfgRowGet(fs, formRow, "habilitado"), true), estacio: cfgRowGet(fs, formRow, "estacio").trim() }
    : { id: formId, nombre: "", habilitado: true, estacio: "" };
  const forms = fs ? fs.rows.filter((row) => cfgRowGet(fs, row, "id").trim() && cfgBool(cfgRowGet(fs, row, "habilitado"), true))
    .map((row) => ({ id: cfgRowGet(fs, row, "id").trim(), nombre: cfgRowGet(fs, row, "nombre"), habilitado: true, estacio: cfgRowGet(fs, row, "estacio").trim() })) : [];
  return { settings: cfgPreviewSettings(formId), campuses: [], weeks: cfgPreviewWeeks(formId), fields: cfgPreviewFields(formId), form, forms };
}

// Envia la config actual a l'iframe de preview (si existeix).
function pushPreviewNow() {
  const iframe = $("cfg-preview-frame");
  if (!iframe || !iframe.contentWindow || !state.config) return;
  const formId = state.cfgPreviewForm || cfgDefaultFormId();
  try { iframe.contentWindow.postMessage({ type: "campus-preview-config", formId, config: cfgBuildPreviewConfig(formId) }, "*"); } catch (e) {}
}
let _cfgPreviewTimer = null;
function schedulePreview() {
  if (!$("cfg-preview-frame")) return;
  clearTimeout(_cfgPreviewTimer);
  _cfgPreviewTimer = setTimeout(pushPreviewNow, 110);
}

// Escala l'iframe: en mode ESCRIPTORI el renderitzem a 1280px lògics (perquè
// el formulari agafi el disseny de PC de veritat, no el de mòbil) i l'encongim
// per encabir-lo al panell; en MÒBIL, a ~402px lògics (mida de telèfon real).
function cfgFitPreview() {
  const stage = $("cfg-preview-stage");
  const device = stage && stage.querySelector(".cfg-preview__device");
  const scaler = $("cfg-preview-scaler");
  const frame = $("cfg-preview-frame");
  if (!stage || !device || !scaler || !frame) return;
  const dev = stage.dataset.dev === "mobile" ? "mobile" : "desktop";
  // Marca el mode al contenidor perquè el split canviï (escriptori 50/50, mòbil 75/25).
  const cv = document.getElementById("config-view");
  if (cv) cv.dataset.previewDev = dev;
  const logicalW = dev === "mobile" ? 440 : 1280;
  const availW = device.clientWidth;   // forçar reflow després de canviar el split
  const availH = device.clientHeight;
  if (!availW || !availH) return;
  const scale = availW / logicalW;
  const logicalH = Math.ceil(availH / scale);
  frame.style.width = logicalW + "px";
  frame.style.height = logicalH + "px";
  scaler.style.width = logicalW + "px";
  scaler.style.height = logicalH + "px";
  scaler.style.transform = `scale(${scale})`;
}

/* ---- Vista ---- */
function showConfigView(show) {
  $("dash").hidden = show;
  $("config-view").hidden = !show;
  $("tabbar").classList.toggle("is-hidden", show);
  $("config-btn").classList.toggle("is-active", show);
  if (show && !state.config) loadConfig();
  else if (show) renderCfg();
  window.scrollTo({ top: 0 });
}

async function loadConfig() {
  $("cfg-body").innerHTML = `<p class="cfg-loading">Carregant la configuració…</p>`;
  try {
    const out = await api("admin_config_get");
    state.config = out.sheets || {};
    CFG_SHEET_NAMES.forEach((n) => {
      if (!state.config[n]) state.config[n] = { header: [], rows: [] };
      if (!state.config[n].header.length) state.config[n].header = (CFG_DEFAULT_HEADERS[n] || ["id"]).slice();
    });
    if (!state.cfgTab) state.cfgTab = "forms";
    state.cfgEdit = null;
    renderCfg();
  } catch (err) {
    if (err.message === "unauthorized") return logout();
    $("cfg-body").innerHTML = `<p class="cfg-loading">No s'ha pogut carregar: ${esc(err.message)}</p>`;
  }
}

function renderCfg() {
  renderCfgTabs();
  if (state.cfgEdit) renderCfgEditor();
  else if (state.cfgTab === "campos") renderCfgCampos();
  else renderCfgForms();
  cfgSyncPreview();
}

// Mostra/amaga el panell de preview i el sincronitza amb el formulari que s'edita.
// L'iframe viu FORA de #cfg-body (a l'aside persistent), de manera que re-renderitzar
// l'editor no el recarrega: només canvia de src quan canvia el formulari previsualitzat.
function cfgSyncPreview() {
  const pane = $("cfg-preview-pane");
  const frame = $("cfg-preview-frame");
  if (!pane || !frame) return;
  const inEditor = !!state.cfgEdit;
  document.getElementById("config-view").classList.toggle("has-preview", inEditor);
  pane.hidden = !inEditor;
  if (!inEditor) { state.cfgPreviewForm = null; return; }
  const formId = state.cfgEdit.form || cfgDefaultFormId();
  state.cfgPreviewForm = formId;
  const src = `index.html?form=${encodeURIComponent(formId)}&preview=1`;
  if (frame.getAttribute("src") !== src) {
    frame.src = src;                       // recàrrega només en canviar de formulari
    const open = $("cfg-preview-open");
    if (open) open.href = `index.html?form=${encodeURIComponent(formId)}`;
  } else {
    pushPreviewNow();                      // mateix formulari → només refresca dades
  }
  // Ajusta l'escala després que el layout del panell s'hagi aplicat.
  requestAnimationFrame(cfgFitPreview);
}

function renderCfgTabs() {
  const tabs = $("cfg-tabs");
  if (!tabs) return;
  if (state.cfgEdit) { tabs.innerHTML = ""; return; }   // dins l'editor no hi ha pestanyes
  const formsDirty = ["Formularios", "Semanas", "Ajustes"].some((n) => cfgSheet(n) && cfgSheet(n)._dirty);
  const camposDirty = cfgSheet("Campos") && cfgSheet("Campos")._dirty;
  tabs.innerHTML = [
    { id: "forms", label: "Formularis", dirty: formsDirty },
    { id: "campos", label: "Preguntes", dirty: camposDirty }
  ].map((t) =>
    `<button class="week-tab${state.cfgTab === t.id ? " is-active" : ""}" data-cfgtab="${t.id}">${t.label}${t.dirty ? ' <span class="cfg-dot">●</span>' : ""}</button>`
  ).join("");
  tabs.querySelectorAll("[data-cfgtab]").forEach((b) =>
    b.addEventListener("click", () => { state.cfgTab = b.dataset.cfgtab; renderCfg(); }));
}

// Barra d'accions comuna. No hi ha botó de desar: els canvis es desen sols
// (autodesat amb un petit retard); l'estat es veu al xip de dalt.
function cfgActionsBar(addLabel, addId) {
  return `<div class="cfg-actions">
    ${addLabel ? `<button class="btn btn--ghost btn--sm" id="${addId}">${addLabel}</button>` : ""}
    <span class="cfg-spacer"></span>
    <button class="btn btn--ghost btn--sm" id="cfg-reload" title="Torna a llegir l'Excel (per si algú l'ha tocat a mà)">↻ Recarrega</button>
  </div>`;
}
function wireCfgCommon() {
  const reload = $("cfg-reload");
  if (reload) reload.addEventListener("click", async () => {
    if (cfgAnyDirty()) await cfgAutoSave();   // primer acaba de desar el que hi hagi pendent
    const ed = state.cfgEdit;
    state.config = null;
    await loadConfig();
    if (ed) { state.cfgEdit = ed; renderCfg(); }
  });
  // Inputs/selects/toggles amb data-col → model en memòria
  $("cfg-body").querySelectorAll("[data-col]").forEach((el) => {
    const sheetName = el.dataset.sheet || "Formularios";
    const sheet = cfgSheet(sheetName);
    const ev = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
    el.addEventListener(ev, () => {
      const r = Number(el.dataset.r);
      const val = el.type === "checkbox" ? (el.checked ? "TRUE" : "FALSE") : el.value;
      cfgRowSet(sheet, r, el.dataset.col, val);
      if (el.type === "checkbox" && /^habilitado$/i.test(el.dataset.col)) {
        const card = el.closest(".cfg-card, .fcard");
        if (card) card.classList.toggle("is-off", !el.checked);
        // A la pàgina dels formularis, el xip d'estat (obertes/tancat) i el
        // «Per defecte» depenen d'aquest interruptor —i el «Per defecte» pot
        // saltar a un altre formulari—, així que refresquem els xips de totes
        // les targetes en directe després del canvi.
        if (sheetName === "Formularios" && $("cfg-body").querySelector(".fcards")) {
          cfgRefreshFormBadges();
        }
      }
      if (el.dataset.col === "tipo") renderCfg();   // mostra/amaga el camp d'opcions
      // Escriure el nom d'un formulari ho encadena tot sol: si no té identificador,
      // se'n crea un (estació + any: «Campus Estiu 2026» → estiu26), i la pestanya
      // de respostes es renova amb l'any (hoja → Inscripcions_estiu26), de manera
      // que cada edició anual guarda les inscripcions en una fulla neta.
      if (sheetName === "Formularios" && el.dataset.col === "nombre") {
        let id = cfgRowGet(sheet, sheet.rows[r], "id").trim();
        if (!id) {
          id = cfgSlugId(val);
          if (id) cfgRowSet(sheet, r, "id", id);
        }
        const yy = (val.match(/20(\d{2})/) || [])[1];
        if (yy && id) cfgRowSet(sheet, r, "hoja", `Inscripcions_${id}${yy}`);
        const hoja = cfgRowGet(sheet, sheet.rows[r], "hoja").trim();
        const line = $("cfg-body").querySelector(`[data-idline="${r}"]`);
        if (line) line.textContent = hoja ? hoja : (id ? `?form=${id}` : "sense identificador");
        const hojaInput = $("cfg-body").querySelector(`[data-sheet="Formularios"][data-r="${r}"][data-col="hoja"]`);
        if (hojaInput) hojaInput.value = hoja;
        const editBtn = $("cfg-body").querySelector(`[data-editrow="${r}"]`);
        if (editBtn && id) editBtn.dataset.editform = id;
      }
    });
  });
}

/* ============ Pàgina principal: ELS FORMULARIS ============ */
// Refresca en directe els xips de cada targeta (estat obert/tancat i «Per
// defecte») a partir del model en memòria, sense repintar tota la llista.
// Es crida quan es toca l'interruptor «Es veu al web» perquè tot quedi
// coherent a l'instant: el «Per defecte» pot canviar de formulari segons
// quin sigui el primer que queda obert.
function cfgRefreshFormBadges() {
  const sheet = cfgSheet("Formularios");
  const firstOpen = sheet.rows.findIndex((row) => cfgBool(cfgRowGet(sheet, row, "habilitado"), true));
  $("cfg-body").querySelectorAll(".fcard").forEach((card) => {
    const input = card.querySelector('.tgl input[data-col="habilitado"]');
    if (!input) return;
    const r = Number(input.dataset.r);
    const open = cfgBool(cfgRowGet(sheet, sheet.rows[r], "habilitado"), true);
    card.classList.toggle("is-off", !open);
    const stateEl = card.querySelector(".fcard__state");
    if (stateEl) {
      stateEl.className = `fcard__state ${open ? "is-open" : "is-closed"}`;
      stateEl.textContent = open ? "Inscripcions obertes" : "Tancat";
    }
    const badges = card.querySelector(".fcard__badges");
    if (badges) {
      const existing = badges.querySelector(".cfg-chip--default");
      const shouldHave = r === firstOpen;
      if (shouldHave && !existing) {
        badges.insertAdjacentHTML("beforeend", `<span class="cfg-chip cfg-chip--default" title="És el que veu la gent que obre el web sense enllaç concret">Per defecte</span>`);
      } else if (!shouldHave && existing) {
        existing.remove();
      }
    }
  });
}
function renderCfgForms() {
  const sheet = cfgSheet("Formularios");
  const firstOpen = sheet.rows.findIndex((row) => cfgBool(cfgRowGet(sheet, row, "habilitado"), true));
  let html = "";
  if (!sheet.rows.length) html += `<p class="cfg-loading">Cap formulari encara — afegeix-ne un.</p>`;

  // Ordre cronològic per a la vista: els més recents primer (per any del nom/id).
  // Conservem l'índex real de cada fila (data-r) perquè editar segueixi apuntant
  // a la fila correcta encara que es mostrin en un altre ordre.
  const order = sheet.rows
    .map((row, r) => ({ row, r }))
    .sort((a, b) => cfgYearOf(sheet, b.row) - cfgYearOf(sheet, a.row));

  html += `<div class="fcards">` + order.map(({ row, r }) => {
    const id = cfgRowGet(sheet, row, "id").trim();
    const season = cfgSeasonOf(sheet, row);
    const sMeta = CFG_SEASONS[season];
    const open = cfgBool(cfgRowGet(sheet, row, "habilitado"), true);
    const dashRaw = cfgRowGet(sheet, row, "dashboard_activo");
    const dash = dashRaw.trim() === "" ? open : cfgBool(dashRaw, true);
    const hoja = cfgRowGet(sheet, row, "hoja").trim();
    return `<div class="fcard${open ? "" : " is-off"}" style="--fc:${sMeta.color}">
      <div class="fcard__banner" aria-hidden="true"></div>
      <div class="fcard__body">
        <div class="fcard__top">
          <span class="fcard__emoji" aria-hidden="true">${sMeta.emoji}</span>
          <div class="fcard__names">
            <input type="text" class="fcard__name" data-sheet="Formularios" data-r="${r}" data-col="nombre" value="${esc(cfgRowGet(sheet, row, "nombre"))}" placeholder="Nom del formulari" aria-label="Nom del formulari">
            <span class="fcard__id" data-idline="${r}">${hoja ? esc(hoja) : (id ? `?form=${esc(id)}` : "sense identificador")}</span>
          </div>
        </div>
        <div class="fcard__badges">
          <span class="fcard__state ${open ? "is-open" : "is-closed"}">${open ? "Inscripcions obertes" : "Tancat"}</span>
          ${r === firstOpen ? `<span class="cfg-chip cfg-chip--default" title="És el que veu la gent que obre el web sense enllaç concret">Per defecte</span>` : ""}
        </div>
        <div class="fcard__controls">
          ${cfgToggleSheet("Formularios", r, "habilitado", open, "Es veu al web")}
          ${cfgToggleSheet("Formularios", r, "dashboard_activo", dash, "Actiu al panell")}
        </div>
        <div class="fcard__foot">
          <button class="btn btn--primary fcard__editbtn" data-editform="${esc(id)}" data-editname="${esc(cfgRowGet(sheet, row, "nombre") || id)}" data-editseason="${esc(season)}" data-editrow="${r}">Edita<span class="fcard__arrow" aria-hidden="true">→</span></button>
          <button class="iconbtn fcard__dup" data-dupform="${r}" title="Duplicar per a un any nou (còpia amb les mateixes setmanes, preus i textos)" aria-label="Duplica el formulari">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          </button>
        </div>
      </div>
    </div>`;
  }).join("") + `</div>`;

  html += `<button class="cfg-generalbtn" id="cfg-editgeneral">
    <span class="cfg-generalbtn__emoji">🌐</span>
    <span class="cfg-generalbtn__txt"><b>Contingut compartit i ajustos generals</b><br>Textos i setmanes comuns a tots els formularis, i coses globals (nom del campus, correu, PIN…)</span>
    <span class="cfg-generalbtn__arrow">→</span>
  </button>`;

  html += cfgActionsBar("+ Afegeix un formulari", "cfg-addform");
  $("cfg-body").innerHTML = html;
  wireCfgCommon();

  $("cfg-body").querySelectorAll("[data-editform]").forEach((b) =>
    b.addEventListener("click", () => {
      const sheetF = cfgSheet("Formularios");
      const r = Number(b.dataset.editrow);
      // L'id pot haver canviat en aquest mateix render (autogenerat en escriure el nom)
      const id = cfgRowGet(sheetF, sheetF.rows[r], "id").trim() || b.dataset.editform;
      if (!id) { toast("Escriu primer un nom: l'identificador es crea sol.", true); return; }
      state.cfgEdit = { form: id, name: cfgRowGet(sheetF, sheetF.rows[r], "nombre") || id, season: b.dataset.editseason || "", row: r };
      renderCfg();
      window.scrollTo({ top: 0 });
    }));
  $("cfg-editgeneral").addEventListener("click", () => {
    state.cfgEdit = { form: "", name: "Contingut compartit", season: "", row: null };
    renderCfg();
    window.scrollTo({ top: 0 });
  });
  $("cfg-body").querySelectorAll("[data-dupform]").forEach((b) =>
    b.addEventListener("click", () => cfgDuplicateForm(Number(b.dataset.dupform))));
  $("cfg-addform").addEventListener("click", () => {
    cfgNewRow(cfgSheet("Formularios"), { habilitado: "TRUE", dashboard_activo: "TRUE" });
    renderCfg();
    const cards = $("cfg-body").querySelectorAll(".fcard");
    const last = cards[cards.length - 1];
    if (last) { last.scrollIntoView({ behavior: "smooth", block: "center" }); const i = last.querySelector(".fcard__name"); if (i) i.focus(); }
  });
}

// Duplica un formulari sencer per a un any nou: còpia de la seva fila + de totes
// les setmanes, ajustos i preguntes que li són pròpies (columna form = id vell).
// El nou neix TANCAT (draft) i amb l'any incrementat al nom/id/pestanya, de manera
// que el formulari vell queda intacte amb el seu històric i el nou el pots retocar.
async function cfgDuplicateForm(r) {
  const fs = cfgSheet("Formularios");
  const src = fs.rows[r];
  if (!src) return;
  const oldId = cfgRowGet(fs, src, "id").trim();
  const oldName = cfgRowGet(fs, src, "nombre");
  // Incrementa l'any al nom (2026 → 2027) si n'hi ha; si no, hi afegeix " (còpia)".
  const bump = (y) => "20" + String(Number(y) + 1).padStart(2, "0");
  const newName = /20\d{2}/.test(oldName)
    ? oldName.replace(/20(\d{2})/, (m, yy) => bump(yy))
    : (oldName ? oldName + " (còpia)" : "Formulari nou");
  // Nou identificador únic (estació + any nou, o l'antic amb sufix).
  const existing = new Set(fs.rows.map((row) => cfgRowGet(fs, row, "id").trim()).filter(Boolean));
  let newId = cfgSlugId(newName) || (oldId ? oldId + "-2" : "form");
  let n = 2;
  while (existing.has(newId)) { newId = (cfgSlugId(newName) || oldId || "form") + "-" + n++; }
  const yy = (newName.match(/20(\d{2})/) || [])[1] || "";

  const ok = await confirmModal({
    title: "Duplicar el formulari?",
    message: `Es crearà «${newName}» com una còpia tancada de «${oldName || oldId}», amb les mateixes setmanes, preus i textos propis. El formulari original i les seves inscripcions no es toquen.`,
    confirmLabel: "Duplica"
  });
  if (!ok) return;

  // 1) Còpia de la fila de Formularios (tancada, com a esborrany).
  fs.rows.push(src.slice());
  const ni = fs.rows.length - 1;
  while (fs.rows[ni].length < fs.header.length) fs.rows[ni].push("");
  cfgRowSet(fs, ni, "id", newId);
  cfgRowSet(fs, ni, "nombre", newName);
  cfgRowSet(fs, ni, "hoja", yy ? `Inscripcions_${newId}${yy}` : (cfgRowGet(fs, src, "hoja") ? cfgRowGet(fs, src, "hoja") + "_copia" : ""));
  cfgRowSet(fs, ni, "habilitado", "FALSE");
  cfgRowSet(fs, ni, "dashboard_activo", "FALSE");

  // 2) Còpia de les files pròpies (form = id vell) de Semanas, Ajustes i Campos.
  let cloned = 0;
  ["Semanas", "Ajustes", "Campos"].forEach((name) => {
    const sh = cfgSheet(name);
    if (!sh) return;
    const add = [];
    sh.rows.forEach((row) => {
      if (cfgRowGet(sh, row, "form").trim() === oldId) {
        const c = row.slice();
        while (c.length < sh.header.length) c.push("");
        add.push(c);
      }
    });
    add.forEach((c) => {
      sh.rows.push(c);
      cfgRowSet(sh, sh.rows.length - 1, "form", newId);
      cloned++;
    });
  });

  renderCfg();
  toast(cloned
    ? `Formulari duplicat (${cloned} element${cloned === 1 ? "" : "s"} propis copiats). Canvia'l i activa'l quan vulguis.`
    : "Formulari duplicat. Canvia'l i activa'l quan vulguis.");
  // Focus al nom del nou (està a dalt de tot per ordre cronològic).
  const card = $("cfg-body").querySelector(`.fcard__name[data-r="${ni}"]`);
  if (card) { card.closest(".fcard").scrollIntoView({ behavior: "smooth", block: "center" }); card.focus(); card.select(); }
}

// Variant de cfgToggle que porta la pestanya al dataset (per a wireCfgCommon).
function cfgToggleSheet(sheetName, rIdx, col, on, label) {
  return `<label class="tgl">
    <input type="checkbox" data-sheet="${esc(sheetName)}" data-r="${rIdx}" data-col="${esc(col)}"${on ? " checked" : ""}>
    <span class="tgl__track" aria-hidden="true"></span>
    <span class="tgl__lbl">${esc(label)}</span>
  </label>`;
}

/* ============ Editor d'un formulari (setmanes + textos, en un sol lloc) ============ */
function renderCfgEditor() {
  const ed = state.cfgEdit;
  const scoped = ed.form !== "";
  const sMeta = CFG_SEASONS[ed.season || ""] || CFG_SEASONS[""];
  let html = `<div class="cfg-edhead" style="--fc:${scoped ? sMeta.color : "#0E2A63"}">
    <button class="cfg-backbtn" id="cfg-back" title="Torna als formularis" aria-label="Torna als formularis">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    <span class="cfg-edhead__emoji" aria-hidden="true">${scoped ? sMeta.emoji : "🌐"}</span>
    <div class="cfg-edhead__titles">
      <span class="cfg-edhead__eyebrow">${scoped ? "Editant el formulari" : "Editant"}</span>
      <span class="cfg-edhead__title">${esc(ed.name)}</span>
    </div>
  </div>`;
  if (scoped) html += `<p class="cfg-hint cfg-hint--tab">Tot el que canviïs aquí només afecta «${esc(ed.name)}». El que estigui marcat com a compartit ve del contingut comú de tots els formularis.</p>`;
  else html += `<p class="cfg-hint cfg-hint--tab">Aquest contingut val per a TOTS els formularis alhora (si un formulari té una versió pròpia d'un text, la seva mana).</p>`;

  // Ordre igual que al formulari: portada (hero) → setmanes → botó/consentiment →
  // confirmació → correu → dades generals → avançat → altres.
  const byGroup = cfgGroupedSettings(ed, scoped);
  html += renderCfgSettingsPanel(ed, scoped, byGroup, { name: "Portada", icon: "🖼️", title: "Portada" });
  html += renderCfgEditorWeeks(ed, scoped, byGroup);   // setmanes + opcions de la secció
  CFG_GROUPS.filter((g) => g.name !== "Portada").forEach((g) => {
    const addBtn = g.name === "Altres ajustos"
      ? `<button class="btn btn--ghost btn--sm" id="cfg-addsetting">+ Clau personalitzada</button>` : "";
    html += renderCfgSettingsPanel(ed, scoped, byGroup, g, addBtn);
  });
  if (scoped) html += renderCfgEditorTech(ed);
  html += cfgActionsBar();
  $("cfg-body").innerHTML = html;
  wireCfgCommon();
  wireCfgEditor(ed, scoped);
  if (scoped) wireCfgEditorTech(ed);
}

// Panell de detalls tècnics d'un formulari (plegat per defecte): identificador,
// pestanya de respostes, estació i eliminació. Viu dins l'editor perquè les
// targetes principals quedin netes i no s'hi toqui res sensible per error.
function renderCfgEditorTech(ed) {
  const fs = cfgSheet("Formularios");
  const r = ed.row;
  if (r == null || !fs.rows[r]) return "";
  const seasonCur = cfgRowGet(fs, fs.rows[r], "estacio").trim().toLowerCase();
  return `<details class="cfg-tech">
    <summary class="cfg-tech__sum"><span class="cfg-sec__icon">⚙️</span> Detalls tècnics i estació</summary>
    <div class="cfg-tech__body">
      <div class="cfg-card__grid">
        <label class="cfg-f"><span class="cfg-f__l">Identificador (va a l'enllaç ?form=…; no el canviïs amb inscripcions en marxa)</span>
          <input type="text" class="cfg-in" data-sheet="Formularios" data-r="${r}" data-col="id" value="${esc(cfgRowGet(fs, fs.rows[r], "id"))}" placeholder="estiu26"></label>
        <label class="cfg-f"><span class="cfg-f__l">Pestanya de respostes (es renova sola amb l'any del nom)</span>
          <input type="text" class="cfg-in" data-sheet="Formularios" data-r="${r}" data-col="hoja" value="${esc(cfgRowGet(fs, fs.rows[r], "hoja"))}" placeholder="Inscripcions_estiu26"></label>
        <label class="cfg-f"><span class="cfg-f__l">Estació (colors i ambient del web)</span>
          <select class="cfg-in" data-sheet="Formularios" data-r="${r}" data-col="estacio">` +
            Object.keys(CFG_SEASONS).map((s) =>
              `<option value="${s}"${s === seasonCur ? " selected" : ""}>${CFG_SEASONS[s].emoji} ${CFG_SEASONS[s].label}</option>`
            ).join("") +
        `</select></label>
      </div>
      <button class="btn btn--danger-ghost btn--sm cfg-delform" id="cfg-delform">Elimina aquest formulari</button>
    </div>
  </details>`;
}
function wireCfgEditorTech(ed) {
  const del = $("cfg-delform");
  if (del) del.addEventListener("click", async () => {
    const fs = cfgSheet("Formularios");
    const r = ed.row;
    const nom = cfgRowGet(fs, fs.rows[r], "nombre") || cfgRowGet(fs, fs.rows[r], "id") || "aquest formulari";
    const ok = await confirmModal({ title: "Eliminar el formulari?", message: `S'eliminarà «${nom}» de la llista. Les inscripcions ja rebudes NO s'esborren (queden a la seva pestanya de l'Excel).`, confirmLabel: "Elimina" });
    if (!ok) return;
    fs.rows.splice(r, 1);
    cfgMarkDirty(fs);
    state.cfgEdit = null;
    renderCfg();
    window.scrollTo({ top: 0 });
  });
  // Canviar l'estació dins dels detalls → repinta perquè l'emoji/color del capçal s'actualitzin.
  const est = $("cfg-body").querySelector('[data-col="estacio"]');
  if (est) est.addEventListener("change", () => {
    state.cfgEdit.season = est.value;
    renderCfg();
  });
}

/* ---- Setmanes (dins l'editor) ---- */
function cfgVisibleWeeks(ed, scoped) {
  const ws = cfgSheet("Semanas");
  return ws.rows
    .map((row, r) => ({ row, r, scope: cfgRowGet(ws, row, "form").trim() }))
    .filter((it) => scoped ? (it.scope === ed.form || it.scope === "") : it.scope === "");
}
function renderCfgEditorWeeks(ed, scoped, byGroup) {
  const ws = cfgSheet("Semanas");
  const items = cfgVisibleWeeks(ed, scoped);
  // Opcions de la secció de setmanes (títol, nota de preus, obligatorietat).
  const optGrid = cfgSettingsGrid(ed, scoped, (byGroup && byGroup["Setmanes"]) || []);
  const optBlock = optGrid ? `<div class="cfg-subhead">Opcions de la secció</div>${optGrid}` : "";
  let html = `<section class="cfg-panel">
    <div class="cfg-sechead">
      <h3 class="cfg-sec__title"><span class="cfg-sec__icon">📅</span> Setmanes</h3>
      <button class="btn btn--ghost btn--sm" id="cfg-addweek">+ Afegeix una setmana</button>
    </div>`;
  if (!items.length) return html + `<p class="cfg-loading">Cap setmana ${scoped ? "per a aquest formulari" : "compartida"} encara.</p>${optBlock}</section>`;
  html += `<div class="cfg-cards">` + items.map((it, vi) => {
    const { row, r } = it;
    const shared = scoped && it.scope === "";
    return `<div class="cfg-card cfg-card--week">
      <div class="cfg-card__head">
        <span class="cfg-card__num">${vi + 1}</span>
        <input type="text" class="cfg-in cfg-in--title" data-sheet="Semanas" data-r="${r}" data-col="etiqueta" value="${esc(cfgRowGet(ws, row, "etiqueta"))}" placeholder="Setmana ${vi + 1}">
        ${shared ? `<span class="cfg-chip" title="Aquesta setmana ve del contingut compartit: editar-la afecta tots els formularis">Compartida</span>` : ""}
        <span class="cfg-rowtools">
          <button class="iconbtn cfg-tool" data-wmove="-1" data-vi="${vi}" title="Puja"${vi === 0 ? " disabled" : ""}>↑</button>
          <button class="iconbtn cfg-tool" data-wmove="1" data-vi="${vi}" title="Baixa"${vi === items.length - 1 ? " disabled" : ""}>↓</button>
          <button class="iconbtn cfg-tool cfg-del" data-wdel="${r}" title="Elimina la setmana">✕</button>
        </span>
      </div>
      <div class="cfg-week__meta">
        <label class="cfg-f"><span class="cfg-f__l">Dates (text que es mostra)</span><input type="text" class="cfg-in" data-sheet="Semanas" data-r="${r}" data-col="fechas" value="${esc(cfgRowGet(ws, row, "fechas"))}" placeholder="29 juny – 3 juliol"></label>
        <label class="cfg-f"><span class="cfg-f__l">Places</span><input type="number" min="0" class="cfg-in" data-sheet="Semanas" data-r="${r}" data-col="plazas" value="${cfgNumVal(cfgRowGet(ws, row, "plazas"))}" placeholder="Sense límit"></label>
      </div>
      <div class="cfg-week__opt">
        ${cfgToggleSheet("Semanas", r, "mostrar_plazas", cfgBool(cfgRowGet(ws, row, "mostrar_plazas"), true), "Mostra les places que queden al web")}
        <span class="cfg-week__opt-hint">Si el desactives, la família no veu quantes places queden (però el límit segueix actiu).</span>
      </div>
      <div class="cfg-prices">
        <div class="cfg-ptable">
          <span class="cfg-ptable__corner">Preus</span>
          <span class="cfg-ptable__h">1a setmana</span>
          <span class="cfg-ptable__h">Reduïda *</span>
          <span class="cfg-ptable__r">General</span>
          <span class="cfg-eur"><input type="number" min="0" class="cfg-in" data-sheet="Semanas" data-r="${r}" data-col="precio" value="${cfgNumVal(cfgRowGet(ws, row, "precio"))}" placeholder="80"></span>
          <span class="cfg-eur"><input type="number" min="0" class="cfg-in" data-sheet="Semanas" data-r="${r}" data-col="precio_dto" value="${cfgNumVal(cfgRowGet(ws, row, "precio_dto"))}" placeholder="—"></span>
          <span class="cfg-ptable__r">Jugadors del club</span>
          <span class="cfg-eur"><input type="number" min="0" class="cfg-in" data-sheet="Semanas" data-r="${r}" data-col="precio_rdb" value="${cfgNumVal(cfgRowGet(ws, row, "precio_rdb"))}" placeholder="—"></span>
          <span class="cfg-eur"><input type="number" min="0" class="cfg-in" data-sheet="Semanas" data-r="${r}" data-col="precio_rdb_dto" value="${cfgNumVal(cfgRowGet(ws, row, "precio_rdb_dto"))}" placeholder="—"></span>
        </div>
        <span class="cfg-prices__hint">* Reduïda: 2a setmana, germans i família nombrosa. Els buits agafen el preu general.</span>
      </div>
    </div>`;
  }).join("") + `</div>${optBlock}</section>`;
  return html;
}
// Identificador automàtic per a setmanes noves (S1, S2… únic a tot el full).
function cfgNextWeekId() {
  const ws = cfgSheet("Semanas");
  let max = 0;
  ws.rows.forEach((row) => {
    const m = cfgRowGet(ws, row, "id").trim().match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return "S" + (max + 1);
}

/* ---- Textos i ajustos (dins l'editor) ---- */
// Troba la fila general (form buit) i la personalitzada (form = id) d'una clau.
function cfgSettingRows(key, formId) {
  const as = cfgSheet("Ajustes");
  let general = null, override = null;
  as.rows.forEach((row, r) => {
    if (cfgRowGet(as, row, "Clave").trim() !== key) return;
    const f = cfgRowGet(as, row, "form").trim();
    if (f === "") { general = { row, r }; }
    else if (formId && f === formId) { override = { row, r }; }
  });
  return { general, override };
}
// Agrupa les claus d'ajust visibles en aquest àmbit (conegudes per grup + extres).
function cfgGroupedSettings(ed, scoped) {
  const as = cfgSheet("Ajustes");
  const known = Object.keys(CFG_SETTINGS_META);
  const byGroup = {};
  known.forEach((key) => {
    const meta = CFG_SETTINGS_META[key];
    if (scoped && meta.scope === "general") return;   // no personalitzables per formulari
    (byGroup[meta.group] = byGroup[meta.group] || []).push({ key, meta });
  });
  const seen = new Set();
  as.rows.forEach((row) => {
    const key = cfgRowGet(as, row, "Clave").trim();
    const f = cfgRowGet(as, row, "form").trim();
    if (!key || known.includes(key) || seen.has(key)) return;
    if (scoped ? f === ed.form : f === "") { seen.add(key); (byGroup["Altres ajustos"] = byGroup["Altres ajustos"] || []).push({ key, meta: null }); }
  });
  return byGroup;
}

// HTML d'una cel·la d'ajust (etiqueta + ajuda + control), amb la lògica de
// valor compartit / personalitzat per formulari.
function cfgSettingCellHtml(ed, scoped, key, meta) {
  const as = cfgSheet("Ajustes");
  const { general, override } = cfgSettingRows(key, scoped ? ed.form : "");
  const active = scoped ? (override || general) : general;
  const val = active ? cfgRowGet(as, active.row, "Valor") : "";
  const isOwn = scoped ? !!override : true;
  const long = (meta && meta.long) || val.includes("\n") || val.length > 70;
  const wide = long || (scoped && !isOwn);
  let control;
  if (scoped && !isOwn) {
    control = `<div class="cfg-inherit">${val ? esc(val).replace(/\n/g, "<br>") : "<i>(buit)</i>"}</div>
      <button class="btn btn--ghost btn--sm" data-custom="${esc(key)}">Personalitza</button>`;
  } else if (meta && meta.bool) {
    const rIdx = active ? active.r : -1;
    control = rIdx === -1
      ? `<button class="btn btn--ghost btn--sm" data-custom="${esc(key)}">Defineix</button>`
      : cfgToggleSheet("Ajustes", rIdx, "Valor", cfgBool(val, false), "Activat");
  } else if (active) {
    control = long
      ? `<textarea class="cfg-in cfg-in--area" data-sheet="Ajustes" data-r="${active.r}" data-col="Valor" rows="${Math.min(6, Math.max(2, val.split("\n").length))}">${esc(val)}</textarea>`
      : `<input type="text" class="cfg-in" data-sheet="Ajustes" data-r="${active.r}" data-col="Valor" value="${esc(val)}">`;
  } else {
    control = long
      ? `<textarea class="cfg-in cfg-in--area" data-skey="${esc(key)}" rows="2" placeholder="(buit)"></textarea>`
      : `<input type="text" class="cfg-in" data-skey="${esc(key)}" placeholder="(buit)">`;
  }
  return `<div class="cfg-setting${wide ? " cfg-setting--wide" : ""}">
    <div class="cfg-setting__info">
      ${meta ? `<span class="cfg-setting__label">${esc(meta.label)}</span>` : `<span class="cfg-setting__label"><code>${esc(key)}</code></span>`}
      ${scoped && isOwn && override ? `<span class="cfg-chip cfg-chip--own">Personalitzat</span>` : ""}
    </div>
    ${meta && meta.help ? `<span class="cfg-setting__help">${esc(meta.help)}</span>` : ""}
    <div class="cfg-setting__ctrl">
      ${control}
      ${scoped && override ? `<button class="iconbtn cfg-tool" data-restore="${esc(key)}" title="Torna al valor compartit">↺</button>` : ""}
      ${!meta && (scoped ? override : general) ? `<button class="iconbtn cfg-tool cfg-del" data-delsetting="${esc(key)}" title="Elimina la clau">✕</button>` : ""}
    </div>
  </div>`;
}

// Graella de cel·les d'un grup (buida → "").
function cfgSettingsGrid(ed, scoped, items) {
  if (!items || !items.length) return "";
  return `<div class="cfg-sgrid">${items.map(({ key, meta }) => cfgSettingCellHtml(ed, scoped, key, meta)).join("")}</div>`;
}

// Panell d'un grup d'ajustos, com a targeta amb icona (buit → "" tret que hi hagi
// botó d'acció al capçal, cas del panell "Altres ajustos").
function renderCfgSettingsPanel(ed, scoped, byGroup, gdef, addBtn) {
  const items = byGroup[gdef.name];
  if ((!items || !items.length) && !addBtn) return "";
  const grid = cfgSettingsGrid(ed, scoped, items);
  return `<section class="cfg-panel">
    <div class="cfg-sechead">
      <h3 class="cfg-sec__title"><span class="cfg-sec__icon">${gdef.icon}</span> ${esc(gdef.title)}</h3>
      ${addBtn || ""}
    </div>
    ${grid || `<p class="cfg-loading">Cap ajust personalitzat encara.</p>`}
  </section>`;
}

function wireCfgEditor(ed, scoped) {
  $("cfg-back").addEventListener("click", () => { state.cfgEdit = null; renderCfg(); window.scrollTo({ top: 0 }); });

  // Setmanes: afegir / moure (entre visibles) / eliminar
  $("cfg-addweek").addEventListener("click", () => {
    cfgNewRow(cfgSheet("Semanas"), { id: cfgNextWeekId(), form: scoped ? ed.form : "" });
    renderCfg();
    const cards = $("cfg-body").querySelectorAll(".cfg-card--week");
    const last = cards[cards.length - 1];
    if (last) { last.scrollIntoView({ behavior: "smooth", block: "center" }); const i = last.querySelector(".cfg-in--title"); if (i) i.focus(); }
  });
  $("cfg-body").querySelectorAll("[data-wmove]").forEach((b) =>
    b.addEventListener("click", () => {
      const items = cfgVisibleWeeks(ed, scoped);
      const vi = Number(b.dataset.vi), ti = vi + Number(b.dataset.wmove);
      if (ti < 0 || ti >= items.length) return;
      const ws = cfgSheet("Semanas");
      const a = items[vi].r, c = items[ti].r;
      const tmp = ws.rows[a]; ws.rows[a] = ws.rows[c]; ws.rows[c] = tmp;
      cfgMarkDirty(ws);
      renderCfg();
    }));
  $("cfg-body").querySelectorAll("[data-wdel]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ws = cfgSheet("Semanas");
      const ri = Number(b.dataset.wdel);
      const shared = cfgRowGet(ws, ws.rows[ri], "form").trim() === "" && scoped;
      const ok = await confirmModal({
        title: "Eliminar la setmana?",
        message: shared ? "Aquesta setmana és COMPARTIDA: s'eliminarà de tots els formularis." : "S'eliminarà del formulari.",
        confirmLabel: "Elimina"
      });
      if (!ok) return;
      ws.rows.splice(ri, 1);
      cfgMarkDirty(ws);
      renderCfg();
    }));

  // Ajustos: crear la fila en escriure per primera vegada (data-skey)
  $("cfg-body").querySelectorAll("[data-skey]").forEach((el) =>
    el.addEventListener("input", () => {
      const as = cfgSheet("Ajustes");
      const r = cfgNewRow(as, { Clave: el.dataset.skey, Valor: el.value, form: scoped ? ed.form : "" });
      // A partir d'ara l'input escriu directament a la fila creada
      el.dataset.sheet = "Ajustes"; el.dataset.r = String(r); el.dataset.col = "Valor";
      el.removeAttribute("data-skey");
      el.addEventListener("input", () => cfgRowSet(as, r, "Valor", el.value));
    }, { once: true }));
  // Personalitza / defineix: crea la fila pròpia (còpia del valor heretat)
  $("cfg-body").querySelectorAll("[data-custom]").forEach((b) =>
    b.addEventListener("click", () => {
      const key = b.dataset.custom;
      const { general } = cfgSettingRows(key, scoped ? ed.form : "");
      const as = cfgSheet("Ajustes");
      const baseVal = general ? cfgRowGet(as, general.row, "Valor") : "";
      cfgNewRow(as, { Clave: key, Valor: baseVal, form: scoped ? ed.form : "" });
      renderCfg();
    }));
  // Torna al valor compartit: elimina la fila personalitzada
  $("cfg-body").querySelectorAll("[data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await confirmModal({ title: "Tornar al valor compartit?", message: "S'eliminarà la versió pròpia d'aquest formulari i tornarà a manar el text compartit.", confirmLabel: "Torna al compartit" });
      if (!ok) return;
      const { override } = cfgSettingRows(b.dataset.restore, ed.form);
      if (override) { cfgSheet("Ajustes").rows.splice(override.r, 1); cfgMarkDirty(cfgSheet("Ajustes")); }
      renderCfg();
    }));
  // Elimina una clau personalitzada (no coneguda)
  $("cfg-body").querySelectorAll("[data-delsetting]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await confirmModal({ title: "Eliminar la clau?", message: "S'eliminarà de l'Excel.", confirmLabel: "Elimina" });
      if (!ok) return;
      const { general, override } = cfgSettingRows(b.dataset.delsetting, scoped ? ed.form : "");
      const target = scoped ? override : general;
      if (target) { cfgSheet("Ajustes").rows.splice(target.r, 1); cfgMarkDirty(cfgSheet("Ajustes")); }
      renderCfg();
    }));
  // Nova clau personalitzada (per a coses que la GUI no coneix)
  $("cfg-addsetting").addEventListener("click", async () => {
    const key = prompt("Nom de la clau (tal com la llegeix el web, p. ex. hero_dates):");
    if (!key || !key.trim()) return;
    cfgNewRow(cfgSheet("Ajustes"), { Clave: key.trim(), Valor: "", form: scoped ? ed.form : "" });
    renderCfg();
  });
}

/* ============ Pestanya PREGUNTES (redisseny compacte i plegable) ============ */
function renderCfgCampos() {
  const sheet = cfgSheet("Campos");
  if (!state.cfgOpenQ) state.cfgOpenQ = new Set();
  let html = `<p class="cfg-hint cfg-hint--tab">Les preguntes del formulari, en ordre. Clica una pregunta per desplegar-ne els detalls; arrossega-la amb les fletxes per reordenar.</p>`;
  if (!sheet.rows.length) html += `<p class="cfg-loading">Cap pregunta encara — afegeix-ne una.</p>`;
  html += `<div class="qlist">` + sheet.rows.map((row, r) => {
    const tipo = cfgRowGet(sheet, row, "tipo").trim().toLowerCase() || "text";
    const tipoLabel = (CFG_TIPOS.find(([v]) => v === tipo) || ["", tipo])[1];
    const color = CFG_TIPO_COLOR[tipo] || "#475569";
    const needsOpts = ["select", "radio", "checkbox"].includes(tipo);
    const isNote = tipo === "nota";
    const oblig = cfgBool(cfgRowGet(sheet, row, "obligatorio"), false);
    const formScope = cfgRowGet(sheet, row, "form").trim();
    const open = state.cfgOpenQ.has(r);
    return `<div class="qcard${open ? " is-open" : ""}" style="--qc:${color}">
      <div class="qcard__head" data-qtoggle="${r}">
        <span class="qcard__num">${r + 1}</span>
        <span class="qcard__title">${esc(cfgRowGet(sheet, row, "etiqueta")) || "<i>Sense text</i>"}</span>
        ${oblig && !isNote ? `<span class="qcard__req" title="Resposta obligatòria">obligatòria</span>` : ""}
        ${formScope ? `<span class="cfg-chip">Només «${esc(formScope)}»</span>` : ""}
        <span class="qcard__type">${esc(tipoLabel)}</span>
        <span class="cfg-rowtools">
          <button class="iconbtn cfg-tool" data-move="-1" data-r="${r}" title="Puja"${r === 0 ? " disabled" : ""}>↑</button>
          <button class="iconbtn cfg-tool" data-move="1" data-r="${r}" title="Baixa"${r === sheet.rows.length - 1 ? " disabled" : ""}>↓</button>
          <button class="iconbtn cfg-tool cfg-del" data-delrow="${r}" title="Elimina">✕</button>
        </span>
        <span class="qcard__caret" aria-hidden="true">▾</span>
      </div>
      <div class="qcard__body"${open ? "" : " hidden"}>
        <div class="cfg-card__grid">
          <label class="cfg-f cfg-f--wide"><span class="cfg-f__l">Text de la pregunta</span><input type="text" class="cfg-in" data-sheet="Campos" data-r="${r}" data-col="etiqueta" value="${esc(cfgRowGet(sheet, row, "etiqueta"))}"></label>
          <label class="cfg-f"><span class="cfg-f__l">Tipus de resposta</span>
            <select class="cfg-in" data-sheet="Campos" data-r="${r}" data-col="tipo">` +
              CFG_TIPOS.map(([v, l]) => `<option value="${v}"${v === tipo ? " selected" : ""}>${esc(l)}</option>`).join("") +
          `</select></label>
          <label class="cfg-f"><span class="cfg-f__l">Grup (secció del formulari)</span><input type="text" class="cfg-in" data-sheet="Campos" data-r="${r}" data-col="grupo" value="${esc(cfgRowGet(sheet, row, "grupo"))}" placeholder="Dades del jugador/a"></label>
          ${needsOpts ? `<label class="cfg-f cfg-f--wide"><span class="cfg-f__l">Opcions (separades amb |)</span><input type="text" class="cfg-in" data-sheet="Campos" data-r="${r}" data-col="opciones" value="${esc(cfgRowGet(sheet, row, "opciones"))}" placeholder="Sí|No"></label>` : ""}
          <label class="cfg-f cfg-f--wide"><span class="cfg-f__l">Text d'ajuda (opcional)</span><input type="text" class="cfg-in" data-sheet="Campos" data-r="${r}" data-col="ayuda" value="${esc(cfgRowGet(sheet, row, "ayuda"))}" placeholder="Explicació sota la pregunta"></label>
          <label class="cfg-f"><span class="cfg-f__l">Identificador (columna de respostes)</span><input type="text" class="cfg-in" data-sheet="Campos" data-r="${r}" data-col="id" value="${esc(cfgRowGet(sheet, row, "id"))}" placeholder="nom_jugador"></label>
          <label class="cfg-f"><span class="cfg-f__l">Per a quin formulari</span>${cfgQFormSelect(r, formScope)}</label>
        </div>
        ${isNote ? "" : `<div class="cfg-card__row">${cfgToggleSheet("Campos", r, "obligatorio", oblig, "Resposta obligatòria")}</div>`}
      </div>
    </div>`;
  }).join("") + `</div>
  <p class="cfg-note">Compte amb els identificadors: les respostes es guarden en columnes de l'Excel amb aquest nom. Si el canvies en un formulari en marxa, les respostes velles i noves quedaran en columnes diferents.</p>`;
  html += cfgActionsBar("+ Afegeix una pregunta", "cfg-addq");
  $("cfg-body").innerHTML = html;
  wireCfgCommon();

  $("cfg-body").querySelectorAll("[data-qtoggle]").forEach((h) =>
    h.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;   // les eines no pleguen/despleguen
      const r = Number(h.dataset.qtoggle);
      state.cfgOpenQ.has(r) ? state.cfgOpenQ.delete(r) : state.cfgOpenQ.add(r);
      renderCfg();
    }));
  $("cfg-body").querySelectorAll("[data-move]").forEach((b) =>
    b.addEventListener("click", () => {
      const sheet = cfgSheet("Campos");
      const r = Number(b.dataset.r), t = r + Number(b.dataset.move);
      if (t < 0 || t >= sheet.rows.length) return;
      const [row] = sheet.rows.splice(r, 1);
      sheet.rows.splice(t, 0, row);
      cfgRenumberCampos(sheet);
      cfgMarkDirty(sheet);
      state.cfgOpenQ = new Set();
      renderCfg();
    }));
  $("cfg-body").querySelectorAll("[data-delrow]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sheet = cfgSheet("Campos");
      const ri = Number(b.dataset.delrow);
      const nom = cfgRowGet(sheet, sheet.rows[ri], "etiqueta") || "aquesta pregunta";
      const ok = await confirmModal({ title: "Eliminar la pregunta?", message: `S'eliminarà «${nom}». Les respostes ja rebudes es conserven a l'Excel.`, confirmLabel: "Elimina" });
      if (!ok) return;
      sheet.rows.splice(ri, 1);
      cfgRenumberCampos(sheet);
      cfgMarkDirty(sheet);
      state.cfgOpenQ = new Set();
      renderCfg();
    }));
  $("cfg-addq").addEventListener("click", () => {
    const sheet = cfgSheet("Campos");
    const r = cfgNewRow(sheet, { tipo: "text" });
    cfgRenumberCampos(sheet);
    state.cfgOpenQ = new Set([r]);
    renderCfg();
    const cards = $("cfg-body").querySelectorAll(".qcard");
    const last = cards[cards.length - 1];
    if (last) { last.scrollIntoView({ behavior: "smooth", block: "center" }); const i = last.querySelector("input"); if (i) i.focus(); }
  });
}
function cfgQFormSelect(rIdx, cur) {
  const fs = cfgSheet("Formularios");
  const ids = fs ? fs.rows.map((row) => cfgRowGet(fs, row, "id").trim()).filter(Boolean) : [];
  if (cur && !ids.includes(cur)) ids.push(cur);
  return `<select class="cfg-in" data-sheet="Campos" data-r="${rIdx}" data-col="form">
    <option value="">Tots els formularis</option>` +
    ids.map((id) => `<option value="${esc(id)}"${id === cur ? " selected" : ""}>Només «${esc(id)}»</option>`).join("") +
  `</select>`;
}

// Reenumera la columna "orden" (1, 2, 3…) segons l'ordre de la llista.
function cfgRenumberCampos(sheet) {
  sheet.rows.forEach((row, i) => {
    let c = cfgColIdx(sheet, "orden");
    if (c === -1) { sheet.header.push("orden"); c = sheet.header.length - 1; }
    while (row.length < sheet.header.length) row.push("");
    row[c] = String(i + 1);
  });
}

/* ---- Autodesat: els canvis viatgen sols a l'Excel al cap d'un moment ---- */
let _cfgSaveTimer = null;
let _cfgSaving = false;
let _cfgStatusTimer = null;
// Xip d'estat del desat: una pampallugueta + etiqueta (Pendent / Desant / Desat / Error).
function cfgSetStatus(txt, kind) {
  const el = $("cfg-status");
  if (!el) return;
  clearTimeout(_cfgStatusTimer);
  el.className = "cfg-status is-shown" + (kind ? ` cfg-status--${kind}` : "");
  el.innerHTML = `<span class="cfg-status__dot" aria-hidden="true"></span><span class="cfg-status__txt">${esc(txt)}</span>`;
  if (kind === "ok") _cfgStatusTimer = setTimeout(() => { el.className = "cfg-status"; el.innerHTML = ""; }, 2500);
}
function scheduleCfgSave() {
  cfgSetStatus("Canvis pendents", "pending");
  clearTimeout(_cfgSaveTimer);
  _cfgSaveTimer = setTimeout(cfgAutoSave, 1200);
}
async function cfgAutoSave() {
  if (_cfgSaving) return;   // en acabar, es reprograma sol si ha quedat res pendent
  const dirty = CFG_SHEET_NAMES.filter((n) => cfgSheet(n) && cfgSheet(n)._dirty);
  if (!dirty.length) return;
  _cfgSaving = true;
  cfgSetStatus("Desant…", "saving");
  let failed = false;
  for (const name of dirty) {
    const sheet = cfgSheet(name);
    const revAtSend = sheet._rev || 0;
    try {
      await api("admin_config_save", { sheet: name, header: sheet.header, rows: sheet.rows });
      // Només net si no s'ha tornat a editar mentre desàvem
      if ((sheet._rev || 0) === revAtSend) sheet._dirty = false;
    } catch (err) {
      failed = true;
      toast("No s'ha pogut desar «" + name + "»: " + err.message, true);
    }
  }
  _cfgSaving = false;
  renderCfgTabs();
  if (cfgAnyDirty()) {
    // O bé han arribat edicions noves mentre desàvem, o bé alguna ha fallat: reintenta.
    clearTimeout(_cfgSaveTimer);
    _cfgSaveTimer = setTimeout(cfgAutoSave, failed ? 5000 : 800);
    if (failed) cfgSetStatus("Error en desar — es reintentarà", "err");
  } else {
    cfgSetStatus("Desat", "ok");
    loadAll();   // refresca el panell (selector de formularis, setmanes, places…)
  }
}

/* ============================================================
   Export CSV
   ============================================================ */
function exportCsv(rowsArg) {
  const rows = rowsArg || state.filtered;
  if (!rows.length) return toast("No hi ha res per exportar.", true);
  const cols = ["ID", "Data", "Jugador/a", "Edat", "Tutor/a", "Email", "Telèfon", "Setmanes", "Grup", "Preu", "Descompte", "Estat"];
  const lines = [cols.join(";")];
  rows.forEach((r) => {
    const vals = [r.id, fmtDate(r.ts), r.nom, r.edat, r.tutor, r.email, r.telefon, r.setmanes, csvGroups(r), r.preu, r.descompte, r.estat];
    lines.push(vals.map(csvCell).join(";"));
  });
  downloadBlob("﻿" + lines.join("\r\n"), `inscripcions_${state.form || "campus"}_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8");
  toast(`${rows.length} files exportades.`);
}

// Exporta la llista de correus únics dels resultats filtrats (per a comunicacions).
function exportEmails() {
  const emails = [...new Set(state.filtered.map((r) => r.email).filter(Boolean))];
  if (!emails.length) return toast("Cap correu als resultats.", true);
  downloadBlob(emails.join("\n"), `emails_${state.form || "campus"}_${new Date().toISOString().slice(0, 10)}.txt`, "text/plain;charset=utf-8");
  toast(`${emails.length} correus exportats.`);
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Grup per a l'exportació: una etiqueta si és igual a totes les setmanes, o "S1:Blau S2:Verd…".
function csvGroups(r) {
  const cols = (r.weekIds || []).map((w) => groupColorOf(r, w));
  if (!cols.length) return "";
  const uniq = [...new Set(cols)];
  if (uniq.length === 1) return GROUP_LABEL[uniq[0]] || uniq[0];
  return r.weekIds.map((w) => `${w}:${GROUP_LABEL[groupColorOf(r, w)] || groupColorOf(r, w)}`).join(" ");
}

/* ============================================================
   Llistes de vestidor imprimibles (punt 3)
   ============================================================ */
function printRosters() {
  const weeks = (state.overview && state.overview.weeks) || [];
  if (!weeks.length) return toast("Sense setmanes per imprimir.", true);
  const groups = state.groups || DEFAULT_GROUPS;
  const camp = (document.querySelector("[data-camp-name]") || {}).textContent || "Campus";
  const formName = (state.forms.find((f) => f.id === state.form) || {}).nombre || state.form || "";

  const noSwimOf = (r) => r.sapNedar && !/^(s|y|1|tru|ok)/i.test(String(r.sapNedar).trim());
  const logo = (() => { try { return new URL("logo.png", location.href).href; } catch (_) { return ""; } })();

  // Targeta-equip d'un grup (vestidor) per a una setmana.
  const ROWS_WEB = 6;    // màx. nens per columna a la web (la resta flueix a una columna del costat)
  const ROWS_PDF = 12;   // màx. nens per columna al PDF
  const teamFor = (g, list) => {
    const hex = GROUP_HEX[g.color] || "#64748B";
    const ll = list.slice().sort((a, b) => (a.nom || "").localeCompare(b.nom || ""));
    const items = ll.map((r) => {
      // 🐠 a l'esquerra (si no sap nedar) i l'edat sempre a la dreta.
      const ns = noSwimOf(r) ? '<span class="ns" title="No sap nedar">🐠</span>' : "";
      const age = r.edat !== "" && r.edat != null ? `<span class="age">${esc(String(r.edat))}a</span>` : "";
      return `<li>${ns}<span class="nm">${esc(r.nom || "—")}</span>${age}</li>`;
    }).join("");
    // Nombre de columnes internes: prou perquè cada columna tingui com a màxim N noms (la llista
    // es reparteix en columnes al costat en lloc de fer scroll). --cw per a la web, --cp per al PDF.
    const cw = Math.max(1, Math.ceil(ll.length / ROWS_WEB));
    const cp = Math.max(1, Math.ceil(ll.length / ROWS_PDF));
    return `<div class="team${ll.length ? "" : " team--empty"}" style="--gc:${hex};--cw:${cw};--cp:${cp}">
      <div class="team__head">
        <span class="team__badge">${ll.length}</span>
        <span class="team__name">${esc(g.label)}</span>
      </div>
      ${ll.length ? `<ol class="team__list">${items}</ol>` : '<p class="team__empty">Cap nen/a</p>'}
    </div>`;
  };

  const sectionFor = (w) => {
    const kids = state.list.filter((r) => (r.weekIds || []).includes(w.id));
    const byColor = {}; groups.forEach((g) => (byColor[g.color] = []));
    kids.forEach((r) => { const c = groupColorOf(r, w.id); (byColor[c] = byColor[c] || []).push(r); });
    const noSwimWeek = kids.filter(noSwimOf).length;
    const teams = groups.map((g) => teamFor(g, byColor[g.color] || [])).join("");
    const nsPill = noSwimWeek ? `<span class="kpi kpi--ns">🐠 ${noSwimWeek} ${noSwimWeek === 1 ? "no neda" : "no neden"}</span>` : "";
    return `<section class="wk" data-week="${esc(w.id)}">
      <div class="wk__banner">
        <div class="wk__bannerL">
          <h2 class="wk__name">${esc(w.etiqueta || w.id)}</h2>
          ${w.fechas ? `<span class="wk__dates">${esc(w.fechas)}</span>` : ""}
        </div>
        <div class="wk__kpis">
          <span class="kpi"><b>${kids.length}</b> ${kids.length === 1 ? "nen/a" : "nens/es"}</span>
          ${nsPill}
        </div>
      </div>
      <div class="teams">${teams}</div>
    </section>`;
  };

  const body = weeks.map(sectionFor).join("");
  const totalKids = state.list.length;
  const chips = `<button class="chip on" data-week="all">Totes</button>` +
    weeks.map((w) => `<button class="chip" data-week="${esc(w.id)}">${esc(w.etiqueta || w.id)}</button>`).join("");

  const css = `
    :root{--navy:#0E2A63;--blue:#1F5AE0;--ink:#16233D;--ink-soft:#5A6B86;--line:#E2E8F4;--paper:#0E1C3D;--danger:#E11D48;}
    *{box-sizing:border-box;}
    [hidden]{display:none!important;}
    body{font-family:"Hanken Grotesk",system-ui,Arial,sans-serif;color:var(--ink);margin:0;padding:0 0 70px;-webkit-font-smoothing:antialiased;
      background:radial-gradient(1200px 700px at 10% -10%,rgba(31,90,224,.20),transparent 55%),
      radial-gradient(1000px 600px at 110% 0%,rgba(99,102,241,.18),transparent 55%),var(--paper);}
    /* Capçalera */
    .hero{position:sticky;top:0;z-index:9;background:rgba(14,28,61,.78);backdrop-filter:saturate(160%) blur(12px);border-bottom:1px solid rgba(255,255,255,.10);}
    .hero__in{max-width:1400px;margin:0 auto;display:flex;align-items:center;gap:14px;padding:14px 18px;}
    .emblem{width:46px;height:46px;border-radius:13px;overflow:hidden;flex:0 0 auto;box-shadow:0 8px 22px rgba(0,0,0,.4);}
    .emblem img{width:100%;height:100%;object-fit:cover;display:block;}
    .hero h1{font-family:"Anton",sans-serif;text-transform:uppercase;letter-spacing:.03em;font-size:1.25rem;color:#fff;margin:0;line-height:1;}
    .hero .sub{font-size:.76rem;color:rgba(255,255,255,.65);font-weight:600;margin-top:3px;}
    .printbtn{margin-left:auto;border:0;cursor:pointer;font-family:inherit;font-weight:800;font-size:.9rem;color:var(--navy);background:#fff;border-radius:999px;padding:11px 20px;box-shadow:0 8px 22px rgba(0,0,0,.3);display:inline-flex;align-items:center;gap:7px;white-space:nowrap;}
    .printbtn:active{transform:translateY(1px);}
    /* Selector de setmanes */
    .picker{max-width:1400px;margin:0 auto;padding:16px 18px 4px;}
    .picker__hint{color:rgba(255,255,255,.6);font-size:.76rem;font-weight:600;margin:0 0 9px;}
    .chips{display:flex;flex-wrap:wrap;gap:8px;}
    .chip{border:1.5px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#fff;font-family:inherit;font-weight:700;font-size:.85rem;border-radius:999px;padding:8px 16px;cursor:pointer;transition:all .15s ease;}
    .chip:hover{border-color:#fff;background:rgba(255,255,255,.14);}
    .chip.on{background:#fff;color:var(--navy);border-color:#fff;box-shadow:0 6px 16px rgba(0,0,0,.25);}
    /* Fila de setmanes + botó de "no nedadors" a la dreta */
    .chips-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
    .chips-row .chips{flex:1 1 auto;}
    /* Botó per mostrar/amagar les marques de "no sap nedar" */
    .optbtn{margin-left:auto;border:1.5px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#fff;font-family:inherit;font-weight:700;font-size:.82rem;border-radius:999px;padding:8px 15px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:all .15s ease;white-space:nowrap;}
    .optbtn:hover{border-color:#fff;}
    .optbtn.is-on{background:rgba(22,163,74,.22);border-color:#34D399;color:#fff;}
    .optbtn:not(.is-on){opacity:.6;}
    /* Quan està amagat, no es mostren ni les icones per nen ni el resum del bàner */
    body.hide-noswim .ns, body.hide-noswim .kpi--ns{display:none!important;}
    /* Quan està amagat, no es mostra l'edat dels nens i nenes */
    body.hide-age .age{display:none!important;}
    /* Setmana */
    .wrap{max-width:1400px;margin:0 auto;padding:10px 18px;}
    .wk{margin:14px 0 26px;}
    .wk__banner{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;
      background:linear-gradient(120deg,var(--blue),#6366F1);border-radius:20px 20px 6px 6px;padding:18px 22px;color:#fff;box-shadow:0 14px 34px rgba(31,90,224,.35);}
    .wk__name{font-family:"Anton",sans-serif;text-transform:uppercase;letter-spacing:.01em;font-size:1.9rem;line-height:.95;margin:2px 0 0;}
    .wk__dates{font-size:.9rem;font-weight:600;opacity:.9;}
    .wk__kpis{display:flex;gap:8px;flex-wrap:wrap;}
    .kpi{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:6px 13px;font-size:.82rem;font-weight:700;white-space:nowrap;}
    .kpi b{font-size:.95rem;}
    .kpi--ns{background:rgba(0,0,0,.22);}
    /* Targetes-equip · graella 2×2 fixa (un grup per quadrant) */
    /* Stretch: les dues taules d'una mateixa fila igualen l'alçada (la més plena marca la mida);
       l'espai sobrant de la més curta es completa amb el color de fons del grup. */
    .teams{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:14px;align-items:stretch;}
    .team{background:color-mix(in srgb,var(--gc) 6%,#fff);border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.22);display:flex;flex-direction:column;}
    .team__head{display:flex;align-items:center;gap:12px;padding:13px 16px;color:#fff;
      background:linear-gradient(135deg,var(--gc),color-mix(in srgb,var(--gc) 62%,#0b1430));}
    .team__badge{flex:0 0 auto;min-width:34px;height:34px;border-radius:50%;background:#fff;color:var(--gc);
      font-family:"Anton",sans-serif;font-size:1.1rem;display:flex;align-items:center;justify-content:center;padding:0 8px;box-shadow:0 3px 8px rgba(0,0,0,.25);}
    .team__name{font-family:"Anton",sans-serif;text-transform:uppercase;letter-spacing:.02em;font-size:1.2rem;}
    /* A la web, omple fins a 6 noms per columna i després passa a la columna del costat
       (column-fill:auto + alçada de 6 files; la fila té alçada fixa perquè el tall sigui exacte). */
    .team__list{list-style:none;margin:0;padding:6px 8px 10px;counter-reset:n;column-count:var(--cw,1);column-gap:10px;column-fill:auto;max-height:248px;}
    .team__list li{display:flex;align-items:center;gap:10px;padding:0 8px;height:38px;box-sizing:border-box;font-size:.95rem;border-radius:9px;break-inside:avoid;-webkit-column-break-inside:avoid;}
    .team__list li:nth-child(odd){background:color-mix(in srgb,var(--gc) 13%,#fff);}
    .team__list li::before{counter-increment:n;content:counter(n);flex:0 0 auto;width:22px;height:22px;border-radius:7px;
      background:color-mix(in srgb,var(--gc) 16%,#fff);color:color-mix(in srgb,var(--gc) 78%,#10203f);font-size:.72rem;font-weight:800;display:flex;align-items:center;justify-content:center;}
    .nm{font-weight:700;color:var(--ink);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .meta{display:flex;align-items:center;gap:7px;flex:0 0 auto;}
    .age{color:#fff;background:color-mix(in srgb,var(--gc) 70%,#10203f);border-radius:6px;padding:1px 7px;font-size:.72rem;font-weight:800;white-space:nowrap;min-width:24px;text-align:center;}
    .ns{flex:0 0 auto;font-size:.95rem;line-height:1;}
    .team--empty{opacity:.55;}
    .team__empty{color:var(--ink-soft);font-size:.85rem;text-align:center;padding:16px 0;margin:0;}
    /* Peu */
    .foot{max-width:1400px;margin:18px auto 0;padding:0 18px;color:rgba(255,255,255,.45);font-size:.74rem;text-align:center;}
    @media(max-width:600px){
      .hero h1{font-size:1.05rem;} .hero .sub{display:none;}
      .printbtn{padding:9px 14px;font-size:.82rem;}
      .teams{grid-template-columns:1fr;}
      .wk__name{font-size:1.5rem;}
    }
    @media print{
      /* Vertical: una setmana sencera per pàgina. Una sola setmana s'escala en línia (fitPrint)
         perquè càpiga SENCERA en una pàgina i no es parteixi mai. */
      @page{size:A4 portrait;margin:8mm;}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
      body{background:#fff!important;padding:0;}
      .hero,.picker,.foot{display:none!important;}
      .wrap{padding:0;}
      /* Mode "Totes": maquetació normal, cada setmana comença en un full nou. */
      body[data-show="all"] .wrap{max-width:none;}
      body[data-show="all"] .wk{margin:0 0 10px;}
      body[data-show="all"] .wk + .wk{break-before:page;page-break-before:always;}
      .wk__banner{box-shadow:none;break-after:avoid;border-radius:10px;padding:12px 16px;}
      .wk__name{font-size:1.4rem;}
      /* Graella 2×2 fixa: un grup per quadrant. Els grups grans reparteixen els noms en
         columnes internes dins del seu quadrant. */
      .teams{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;align-items:stretch;}
      .team{overflow:hidden;box-shadow:none;border:1px solid #ccc;
            break-inside:avoid;page-break-inside:avoid;-webkit-column-break-inside:avoid;}
      /* PDF: omple fins a 12 noms per columna i després passa a la del costat
         (column-fill:auto + alçada de 12 files de 26px). */
      .team__list{column-count:var(--cp,1);column-gap:10px;padding:4px 7px 7px;column-fill:auto;max-height:328px;}
      .team__head{padding:9px 13px;}
      .team__name{font-size:1.05rem;}
      .team__badge{min-width:28px;height:28px;font-size:.95rem;}
      .team__list li{padding:0 7px;height:26px;font-size:.84rem;}
      .team__list li::before{width:18px;height:18px;}
    }`;

  const js = `
    var MM = 3.7795;   // 1 mm en px (referència 96dpi)
    // Treu tot l'escalat i deixa la maquetació natural.
    function resetFit(){
      var wrap = document.querySelector('.wrap');
      document.querySelectorAll('.wk').forEach(function(s){ s.style.transform=''; s.style.margin=''; });
      wrap.style.height=''; wrap.style.overflow=''; wrap.style.width=''; wrap.style.maxWidth='';
      wrap.style.paddingTop=''; wrap.style.paddingBottom='';
      document.body.style.overflow='';
    }
    // Encaixa la setmana visible en una caixa d'alçada 'boxH'. Si 'boxW' ve donat, també hi
    // ajusta l'amplada (mode impressió: la caixa és una pàgina). Compta marges i padding perquè
    // la foto càpiga SENCERA, sense tall ni scroll.
    function applyFit(boxH, boxW){
      var wrap = document.querySelector('.wrap');
      resetFit();
      if (document.body.dataset.show==='all'){ return; }   // "Totes": maquetació normal
      var wk = document.querySelector('.wk:not([hidden])');
      if (!wk){ return; }
      // mesura net: sense marge de la targeta ni padding vertical del contenidor
      document.querySelectorAll('.wk').forEach(function(s){ s.style.margin='0'; });
      wrap.style.paddingTop='0'; wrap.style.paddingBottom='0';
      if (boxW){ wrap.style.width=boxW+'px'; wrap.style.maxWidth=boxW+'px'; }
      else { window.scrollTo(0,0); }
      // Alçada de referència = la setmana MÉS ALTA (mesurem totes, encara que estiguin amagades).
      // Així totes fan servir la MATEIXA escala i, per tant, la mateixa amplada.
      var ref = 0;
      document.querySelectorAll('.wk').forEach(function(s){
        var wasHidden = s.hidden; s.hidden = false;
        var h = s.offsetHeight; if (h > ref) ref = h;
        s.hidden = wasHidden;
      });
      var nw = wk.offsetWidth;
      if (ref<=0 || boxH<=0) return;
      var scale = Math.min(1, (boxH-4)/ref);
      if (boxW){ scale = Math.min(scale, boxW/nw); }
      wk.style.transformOrigin = boxW ? 'top left' : 'top center';
      wk.style.transform = scale<1 ? 'scale('+scale+')' : '';
      wrap.style.height = boxH+'px';
      wrap.style.overflow='hidden';
      if (!boxW) document.body.style.overflow='hidden';
    }
    // Pantalla: NO escalem. Cada setmana individual es mostra exactament a la mateixa amplada
    // que la vista "Totes" (amplada completa); si és molt alta, la pàgina fa scroll amb normalitat.
    // L'encaix a una pàgina només s'aplica en imprimir (fitPrint).
    function fit(){ resetFit(); }
    // Impressió: encaixa la setmana en UNA pàgina A4 vertical (marges 8mm) → mai es parteix.
    function fitPrint(){
      if (document.body.dataset.show==='all'){ resetFit(); return; }
      applyFit((297-16)*MM, (210-16)*MM);
    }
    function pick(w){
      document.body.dataset.show=w;
      document.querySelectorAll('.wk').forEach(function(s){ s.hidden = (w!=='all' && s.dataset.week!==w); });
      document.querySelectorAll('.chip').forEach(function(c){ c.classList.toggle('on', c.dataset.week===w); });
      fit();
    }
    document.querySelectorAll('.chip').forEach(function(c){ c.addEventListener('click', function(){ pick(c.dataset.week); }); });
    window.addEventListener('resize', fit);
    window.addEventListener('load', fit);
    window.addEventListener('beforeprint', fitPrint);
    window.addEventListener('afterprint', fit);
    // En obrir, mostra la primera setmana ja encaixada (foto completa sense scroll).
    var firstChip = document.querySelector('.chip[data-week]:not([data-week="all"])');
    if (firstChip){ pick(firstChip.dataset.week); } else { fit(); }
    // Botó per mostrar/amagar les marques de "no sap nedar" (per defecte, mostrades).
    var nsBtn = document.getElementById('toggle-ns');
    function renderNs(){
      var shown = !document.body.classList.contains('hide-noswim');
      nsBtn.classList.toggle('is-on', shown);
      nsBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
      nsBtn.title = shown ? 'Amaga les marques de "no sap nedar"' : 'Mostra les marques de "no sap nedar"';
    }
    nsBtn.addEventListener('click', function(){ document.body.classList.toggle('hide-noswim'); renderNs(); fit(); });
    renderNs();
    // Botó per mostrar/amagar l'edat dels nens i nenes (per defecte, mostrada).
    var ageBtn = document.getElementById('toggle-age');
    function renderAge(){
      var shown = !document.body.classList.contains('hide-age');
      ageBtn.classList.toggle('is-on', shown);
      ageBtn.setAttribute('aria-pressed', shown ? 'true' : 'false');
      ageBtn.title = shown ? "Amaga l'edat dels nens i nenes" : "Mostra l'edat dels nens i nenes";
    }
    ageBtn.addEventListener('click', function(){ document.body.classList.toggle('hide-age'); renderAge(); fit(); });
    renderAge();
    // Refit després de carregar fonts/imatges (poden canviar l'alçada mesurada).
    setTimeout(fit, 350);
    if (document.fonts && document.fonts.ready){ document.fonts.ready.then(fit); }`;

  const doc = `<!DOCTYPE html><html lang="ca"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Llistes de vestidor · ${esc(camp)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Anton&family=Hanken+Grotesk:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>${css}</style></head>
    <body data-show="all">
      <div class="hero"><div class="hero__in">
        ${logo ? `<span class="emblem"><img src="${logo}" alt=""></span>` : ""}
        <div><h1>Grups i vestidors</h1><div class="sub">${esc(camp)} · ${esc(formName)} · ${new Date().toLocaleDateString("ca-ES")}</div></div>
        <button class="printbtn" onclick="window.print()">🖨️ Imprimir</button>
      </div></div>
      <div class="picker">
        <p class="picker__hint">Tria una setmana per compartir-la (captura de pantalla) o imprimir-la · «Totes» per veure-les juntes</p>
        <div class="chips-row">
          <div class="chips">${chips}</div>
          <button class="optbtn is-on" id="toggle-ns" type="button">🐠 Mostrar no nedadors</button>
          <button class="optbtn is-on" id="toggle-age" type="button">🎂 Mostrar edat</button>
        </div>
      </div>
      <div class="wrap">${body}</div>
      <p class="foot">${esc(camp)} · ${totalKids} inscrits en total</p>
      <script>${js}<\/script>
    </body></html>`;

  // Mostra la vista DINS de la mateixa pàgina (overlay amb un iframe aïllat), no en una pestanya
  // nova. Funciona igual a la web i a la PWA. L'iframe aïlla els estils (no xoquen amb el panell)
  // i la impressió segueix imprimint només el contingut de l'iframe (botó "Imprimir" de dins).
  let ov = document.getElementById("rosters-overlay");
  if (!ov) { ov = document.createElement("div"); ov.id = "rosters-overlay"; document.body.appendChild(ov); }
  ov.innerHTML = `
    <div class="rovl__bar">
      <button class="rovl__home" id="rovl-home" type="button" aria-label="Tornar al panell">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>
        Inici
      </button>
      <span class="rovl__title">Grups i vestidors</span>
    </div>
    <iframe class="rovl__frame" id="rovl-frame" title="Llistes de vestidor"></iframe>`;
  ov.hidden = false;
  document.body.classList.add("rovl-open");
  document.getElementById("rovl-frame").srcdoc = doc;

  const closeRosters = () => {
    ov.hidden = true; ov.innerHTML = "";
    document.body.classList.remove("rovl-open");
    document.removeEventListener("keydown", onRostersKey);
  };
  function onRostersKey(e) { if (e.key === "Escape") closeRosters(); }
  document.getElementById("rovl-home").addEventListener("click", closeRosters);
  document.addEventListener("keydown", onRostersKey);
}

/* ============================================================
   Indicadors clau + comparativa entre formularis (punt 4)
   ============================================================ */
function renderInsights() {
  const box = $("chart-insights");
  if (!box) return;
  const list = state.list || [];
  const weeks = (state.overview && state.overview.weeks) || [];
  // Ompliment global: places ocupades (segons inscrits per setmana) sobre places totals.
  let cap = 0, occ = 0;
  weeks.forEach((w) => {
    const inscrits = list.filter((r) => (r.weekIds || []).includes(w.id)).length;
    occ += inscrits;
    if (w.plazas != null) cap += w.plazas;
  });
  const fill = cap > 0 ? Math.round((occ / cap) * 100) : null;
  const totalWeeks = list.reduce((s, r) => s + (r.weekIds || []).length, 0);
  const avgWeeks = list.length ? (totalWeeks / list.length) : 0;
  const ages = list.map((r) => Number(r.edat)).filter((a) => !isNaN(a));
  const avgAge = ages.length ? (ages.reduce((s, a) => s + a, 0) / ages.length) : 0;

  const items = [
    { val: fill != null ? fill + "%" : "—", lbl: "Ompliment global" + (cap ? ` (${occ}/${cap})` : "") },
    { val: avgWeeks ? avgWeeks.toFixed(1) : "—", lbl: "Setmanes per nen/a (mitjana)" },
    { val: avgAge ? avgAge.toFixed(1) : "—", lbl: "Edat mitjana" },
    { val: occ, lbl: "Places ocupades (total)" }
  ];
  box.innerHTML = items.map((i) =>
    `<div class="stat-chip"><span class="stat-chip__val">${esc(String(i.val))}</span><span class="stat-chip__lbl">${esc(i.lbl)}</span></div>`
  ).join("");
}

// Compara jugadors i ingressos entre tots els formularis (càrrega sota demanda).
async function loadComparison() {
  const box = $("compare-box");
  if (!box) return;
  if (!box.hidden && box.dataset.loaded === "1") { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<p class="compare__loading">Carregant comparativa…</p>`;
  try {
    const results = await Promise.all(state.forms.map(async (f) => {
      try {
        const out = await api("admin_data", { form: f.id });
        const k = (out.overview && out.overview.kpis) || {};
        return { id: f.id, nombre: f.nombre || f.id, jugadors: k.jugadors || 0, ingressos: k.ingressos_total || 0 };
      } catch (_) { return { id: f.id, nombre: f.nombre || f.id, jugadors: 0, ingressos: 0 }; }
    }));
    const maxJ = Math.max(1, ...results.map((r) => r.jugadors));
    const rows = results.map((r) => `
      <div class="compare__row">
        <span class="compare__name">${esc(r.nombre)}</span>
        <span class="compare__track"><span class="compare__bar" data-w="${Math.round((r.jugadors / maxJ) * 100)}"></span></span>
        <span class="compare__val">${r.jugadors} <span class="compare__sub">· ${eur(r.ingressos)}</span></span>
      </div>`).join("");
    box.innerHTML = rows;
    box.dataset.loaded = "1";
    requestAnimationFrame(() => box.querySelectorAll(".compare__bar").forEach((b) => (b.style.width = b.dataset.w + "%")));
  } catch (err) {
    box.innerHTML = `<p class="compare__loading">No s'ha pogut carregar: ${esc(err.message)}</p>`;
  }
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer = null;
function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("is-error", !!isError);
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add("is-show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("is-show"); setTimeout(() => (t.hidden = true), 280); }, 3200);
}

/* ============================================================
   MODE DEMO (sense backend) — dades generades
   ============================================================ */
// Llista de formularis del mode demo (el selector de dalt).
const DEMO_FORMS = [
  { id: "estiu", nombre: "Casal d'Estiu 2026", habilitado: true, dashboardActiu: true },
  { id: "primavera", nombre: "Casal de Primavera 2027", habilitado: true, dashboardActiu: false },
  { id: "hivern", nombre: "Casal de Nadal 2026", habilitado: false, dashboardActiu: false }
];

// Cada formulari té el seu propi conjunt de dades (setmanes, nom i quantitat),
// així el selector es nota: cada tria mostra inscripcions diferents.
const DEMO_FORM_CFG = {
  estiu: {
    nombre: "Casal d'Estiu 2026", count: 34,
    weeks: [
      { id: "S1", etiqueta: "Setmana 1", fechas: "29 juny – 3 jul", plazas: 25 },
      { id: "S2", etiqueta: "Setmana 2", fechas: "6 – 10 jul", plazas: 25 },
      { id: "S3", etiqueta: "Setmana 3", fechas: "13 – 17 jul", plazas: 20 },
      { id: "S4", etiqueta: "Setmana 4", fechas: "20 – 24 jul", plazas: 25 },
      { id: "S5", etiqueta: "Setmana 5", fechas: "27 – 31 jul", plazas: 25 }
    ]
  },
  primavera: {
    nombre: "Casal de Primavera 2027", count: 14,
    weeks: [
      { id: "D1", etiqueta: "Dissabte 1", fechas: "11 abril", plazas: 20 },
      { id: "D2", etiqueta: "Dissabte 2", fechas: "18 abril", plazas: 20 },
      { id: "D3", etiqueta: "Dissabte 3", fechas: "25 abril", plazas: 20 },
      { id: "D4", etiqueta: "Dissabte 4", fechas: "2 maig", plazas: 20 }
    ]
  },
  hivern: {
    nombre: "Casal de Nadal 2026", count: 9,
    weeks: [
      { id: "H1", etiqueta: "Setmana única", fechas: "22 – 26 desembre", plazas: 18 }
    ]
  }
};

let _demo = {};
function demoData(form) {
  form = form || "estiu";
  if (_demo[form]) return _demo[form];
  const cfg = DEMO_FORM_CFG[form] || DEMO_FORM_CFG.estiu;
  const noms = ["Marc Puig", "Laia Soler", "Jan Vidal", "Aina Roca", "Pol Ferrer", "Júlia Mas", "Bruna Costa", "Nil Serra", "Ona Vila", "Roc Camps", "Èlia Pujol", "Arnau Bosch", "Mar Riba", "Biel Font", "Carla Sala", "Pau Llopis", "Vera Grau", "Guim Soto", "Noa Prat", "Roger Coll"];
  const tutors = ["Anna Puig", "David Soler", "Marta Vidal", "Jordi Roca", "Sara Ferrer", "Albert Mas"];
  const weeks = cfg.weeks;
  const rows = []; const occ = {};
  weeks.forEach((w) => (occ[w.id] = 0));
  for (let i = 0; i < cfg.count; i++) {
    const nom = noms[i % noms.length] + (i >= noms.length ? " " + (i) : "");
    const wsel = weeks.filter(() => Math.random() > 0.55);
    if (!wsel.length) wsel.push(weeks[i % weeks.length]);
    const rdb = Math.random() > 0.6, fn = Math.random() > 0.85;
    const preu = wsel.reduce((s, _, idx) => s + (idx === 0 ? (rdb ? 70 : 80) : (rdb ? 60 : 70)), 0);
    const desc = [rdb && "C.P. Riudebitlles", fn && "Família nombrosa"].filter(Boolean).join(", ") || "-";
    wsel.forEach((w) => occ[w.id]++);
    // ~55% han pujat la targeta sanitària al formulari (enllaç de Drive d'exemple).
    const card = Math.random() > 0.45 ? "https://drive.google.com/file/d/EXEMPLE-targeta-" + i + "/view" : "";
    const day = new Date(2026, 4, 1 + Math.floor(i / 1.6));
    // Pagament per setmanes: ~45% totes pagades, ~30% parcial, ~25% cap.
    const wids = wsel.map((w) => w.id);
    const roll = Math.random();
    const paidWeeks = roll < 0.45 ? wids.slice()
      : roll < 0.75 ? wids.filter(() => Math.random() > 0.5)
      : [];
    const estat = paidWeeks.length === 0 ? "Pendent" : paidWeeks.length >= wids.length ? "Pagat" : "Parcial";
    const swim = Math.random() > 0.25 ? "Sí" : "No";
    rows.push({
      id: "INS-" + (1700000000000 + i * 99000) + (Math.random() > 0.8 ? "-1" : ""),
      baseId: "INS-" + i, row: i + 2, ts: day.toISOString().slice(0, 10),
      formulario: cfg.nombre, nom,
      tutor: tutors[i % tutors.length], email: nom.toLowerCase().replace(/\s+/g, ".") + "@exemple.cat",
      telefon: "6" + (10000000 + Math.floor(Math.random() * 8999999)),
      edat: 4 + (i % 11), setmanes: wids.join(", "),
      weekIds: wids, paidWeeks, preu, descompte: desc, estat,
      grups: {}, sapNedar: swim,
      fitxers: card ? [card] : [],
      detall: [
        { id: "nom_jugador", tipo: "text", label: "Nom i cognoms", value: nom, grup: "Dades del jugador/a", esJugador: true },
        { id: "data_naixement", tipo: "date", label: "Data de naixement", value: `1${i % 9}/0${1 + i % 8}/20${10 + i % 9}`, grup: "Dades del jugador/a", esJugador: true },
        { id: "sap_nedar", tipo: "radio", opciones: "Sí|No", label: "Sap nedar?", value: swim, grup: "Dades del jugador/a", esJugador: true },
        ...(card ? [{ id: "targeta_sanitaria", tipo: "file", label: "Còpia de la targeta sanitària", value: card, grup: "Documentació", esJugador: true }] : []),
        { id: "nom_tutor", tipo: "text", label: "Nom del tutor/a", value: tutors[i % tutors.length], grup: "Dades del tutor/a", esJugador: false },
        { id: "telefon", tipo: "tel", label: "Telèfon", value: "6" + (10000000 + Math.floor(Math.random() * 8999999)), grup: "Dades del tutor/a", esJugador: false }
      ]
    });
  }
  const perDay = {}; rows.forEach((r) => (perDay[r.ts] = (perDay[r.ts] || 0) + 1));
  const ages = {}; rows.forEach((r) => (ages[r.edat] = (ages[r.edat] || 0) + 1));
  _demo[form] = { weeks, occ, rows, perDay, ages };
  return _demo[form];
}

// Configuració d'exemple per a la pàgina "Configuració" en mode demo.
let _demoConfig = null;
function demoConfig() {
  if (_demoConfig) return _demoConfig;
  _demoConfig = {
    Formularios: {
      header: ["id", "nombre", "habilitado", "dashboard_activo", "hoja"],
      rows: [
        ["estiu", "Casal d'Estiu 2026", "TRUE", "TRUE", ""],
        ["primavera", "Casal de Primavera 2027", "TRUE", "FALSE", ""],
        ["hivern", "Casal de Nadal 2026", "FALSE", "FALSE", ""]
      ]
    },
    Semanas: {
      header: ["id", "etiqueta", "fechas", "plazas", "precio", "precio_dto", "precio_rdb", "precio_rdb_dto", "form"],
      rows: [
        ["S1", "Setmana 1", "29 juny – 3 juliol", "20", "80", "70", "70", "60", ""],
        ["S2", "Setmana 2", "6 – 10 juliol", "20", "80", "70", "70", "60", ""],
        ["S3", "Setmana 3", "13 – 17 juliol", "20", "80", "70", "70", "60", ""]
      ]
    },
    Ajustes: {
      header: ["Clave", "Valor", "form"],
      rows: [
        ["hero_titulo", "Casal d'Hoquei d'Estiu", ""],
        ["lema", "Inscripcions obertes", ""],
        ["hero_horari", "9 – 13 h", ""]
      ]
    },
    Campos: {
      header: ["id", "etiqueta", "tipo", "opciones", "obligatorio", "placeholder", "ayuda", "grupo", "orden", "form"],
      rows: [
        ["nom_jugador", "Nom i cognoms", "text", "", "TRUE", "", "", "Dades del jugador/a", "1", ""],
        ["data_naixement", "Data de naixement", "date", "", "TRUE", "", "", "Dades del jugador/a", "2", ""],
        ["sap_nedar", "Sap nedar?", "radio", "Sí|No", "TRUE", "", "", "Dades del jugador/a", "3", ""]
      ]
    }
  };
  return _demoConfig;
}

let _demoGroups = DEFAULT_GROUPS.slice();
function demoOverview(d) {
  let total = 0, cobrats = 0, pagat = 0, parcial = 0, pendent = 0;
  const disc = { rdb: 0, fn: 0, germa: 0, cap: 0 };
  d.rows.forEach((r) => {
    total += r.preu;
    const reg = (r.weekIds || []).length;
    const paid = (r.paidWeeks || []).length;
    if (r.estat === "Pagat") pagat++; else if (r.estat === "Parcial") parcial++; else pendent++;
    if (reg) cobrats += r.preu * (paid / reg);
    let any = false;
    if (/riudebitlles/i.test(r.descompte)) { disc.rdb++; any = true; }
    if (/nombrosa/i.test(r.descompte)) { disc.fn++; any = true; }
    if (/-1$/.test(r.id)) { disc.germa++; any = true; }
    if (!any) disc.cap++;
  });
  cobrats = Math.round(cobrats);
  const families = new Set(d.rows.map((r) => r.tutor)).size;
  return {
    ok: true, form: state.form, generatedAt: new Date().toISOString(),
    kpis: { jugadors: d.rows.length, enviaments: d.rows.length - 3, families, ingressos_total: total, ingressos_cobrats: cobrats, ingressos_pendents: total - cobrats, preu_mitja: Math.round(total / d.rows.length) },
    weeks: d.weeks.map((w) => ({ id: w.id, etiqueta: w.etiqueta, fechas: w.fechas, plazas: w.plazas, inscrits: d.occ[w.id] })),
    perDay: Object.keys(d.perDay).sort().map((k) => ({ date: k, count: d.perDay[k] })),
    ages: Object.keys(d.ages).map(Number).sort((a, b) => a - b).map((a) => ({ age: a, count: d.ages[a] })),
    discounts: disc, payments: { Pagat: pagat, Parcial: parcial, Pendent: pendent },
    groups: _demoGroups,
    recent: d.rows.slice(-8).reverse()
  };
}
async function demoApi(action, extra) {
  await new Promise((r) => setTimeout(r, 120));
  if (action === "admin_login") {
    if ((extra && extra.pin) !== DEMO_PIN) throw new Error("unauthorized");
    return { ok: true, token: "DEMO-TOKEN", forms: DEMO_FORMS, settings: { nombre_campus: "Campus d'Hoquei Riudebitlles", club: "El plaer de jugar!" } };
  }
  if (action === "admin_session" || action === "admin_logout") {
    return { ok: true, forms: DEMO_FORMS, settings: { nombre_campus: "Campus d'Hoquei Riudebitlles", club: "El plaer de jugar!" } };
  }
  const d = demoData((extra && extra.form) || state.form);
  if (action === "admin_data") {
    return { ok: true, overview: demoOverview(d), list: d.rows.slice().reverse() };
  }
  if (action === "admin_overview") return demoOverview(d);
  if (action === "admin_list") return { ok: true, form: state.form, rows: d.rows.slice().reverse() };
  if (action === "admin_set_group") {
    const r = (extra.row != null && d.rows.find((x) => String(x.row) === String(extra.row)))
      || d.rows.find((x) => x.id === extra.id);
    if (r) {
      r.grups = r.grups || {};
      if (!extra.color) delete r.grups[extra.week]; else r.grups[extra.week] = extra.color;
      return { ok: true, id: extra.id, grups: r.grups };
    }
    return { ok: false, error: "row not found" };
  }
  if (action === "admin_set_groups_config") {
    _demoGroups = (extra.config || []).map((c) => ({ color: c.color, label: GROUP_LABEL[c.color] || c.color, min: Number(c.min) || 0, max: Number(c.max) || 99 }));
    return { ok: true, groups: _demoGroups };
  }
  if (action === "admin_set_payment") {
    const r = (extra.row != null && d.rows.find((x) => String(x.row) === String(extra.row)))
      || d.rows.find((x) => x.id === extra.id);
    if (r) {
      const paid = (extra.weeks || []).filter((w) => (r.weekIds || []).includes(w));
      r.paidWeeks = paid;
      r.estat = paid.length === 0 ? "Pendent" : paid.length >= (r.weekIds || []).length ? "Pagat" : "Parcial";
      return { ok: true, id: extra.id, estat: r.estat, paidWeeks: paid };
    }
    return { ok: false, error: "row not found" };
  }
  if (action === "admin_set_weeks") {
    const r = (extra.row != null && d.rows.find((x) => String(x.row) === String(extra.row)))
      || d.rows.find((x) => x.id === extra.id);
    if (!r) return { ok: false, error: "row not found" };
    const ids = d.weeks.map((w) => w.id);
    const selected = (extra.weeks || []).filter((w) => ids.includes(w));
    if (!selected.length) return { ok: false, error: "Cal deixar almenys una setmana." };
    r.weekIds = selected;
    r.setmanes = selected.map((wid) => { const w = d.weeks.find((x) => x.id === wid); return (w && w.etiqueta) || wid; }).join(", ");
    r.paidWeeks = (r.paidWeeks || []).filter((w) => selected.includes(w));
    r.estat = r.paidWeeks.length === 0 ? "Pendent" : r.paidWeeks.length >= selected.length ? "Pagat" : "Parcial";
    if (extra.preu != null && String(extra.preu) !== "") r.preu = Number(extra.preu) || 0;
    return { ok: true, id: extra.id, weekIds: selected, setmanes: r.setmanes, paidWeeks: r.paidWeeks, estat: r.estat, preu: r.preu };
  }
  if (action === "admin_config_get") {
    return { ok: true, sheets: JSON.parse(JSON.stringify(demoConfig())) };
  }
  if (action === "admin_config_save") {
    const cfg = demoConfig();
    const body = (extra.rows || []).filter((r) => (r || []).some((v) => String(v).trim() !== ""));
    cfg[extra.sheet] = { header: extra.header || [], rows: body };
    return { ok: true, sheet: extra.sheet, rows: body.length };
  }
  if (action === "admin_update_fields") {
    const r = (extra.row != null && d.rows.find((x) => String(x.row) === String(extra.row)))
      || d.rows.find((x) => x.id === extra.id);
    if (!r) return { ok: false, error: "row not found" };
    const patch = extra.patch || {};
    (r.detall || []).forEach((it) => { if (it.id && patch[it.id] != null) it.value = String(patch[it.id]); });
    if (patch.nom_jugador) r.nom = patch.nom_jugador;
    if (patch.nom_tutor) r.tutor = patch.nom_tutor;
    if (patch.telefon) r.telefon = patch.telefon;
    if (patch.data_naixement) { const y = Number(String(patch.data_naixement).slice(0, 4)); if (y) r.edat = Math.max(0, new Date().getFullYear() - y); }
    if (extra.preu != null && String(extra.preu) !== "") r.preu = Number(extra.preu) || 0;
    if (extra.descompte != null) r.descompte = String(extra.descompte) || "-";
    return { ok: true, id: r.id, updated: patch, nom: r.nom, tutor: r.tutor, email: r.email, telefon: r.telefon, edat: r.edat, preu: r.preu, descompte: r.descompte };
  }
  if (action === "admin_set_status") {
    const r = d.rows.find((x) => x.id === extra.id);
    if (r) { r.paidWeeks = extra.estat === "Pagat" ? (r.weekIds || []).slice() : []; r.estat = extra.estat; }
    return { ok: true, id: extra.id, estat: extra.estat };
  }
  if (action === "admin_resend") {
    const r = d.rows.find((x) => x.id === extra.id);
    return { ok: true, id: extra.id, to: r ? r.email : "" };
  }
  if (action === "admin_reminder") {
    const ids = extra.ids || (extra.id ? [extra.id] : []);
    let sent = 0;
    ids.forEach((id) => { const r = d.rows.find((x) => x.id === id); if (r && r.email && r.estat !== "Pagat") sent++; });
    return { ok: true, sent };
  }
  if (action === "admin_receipt") {
    const ids = extra.ids || (extra.id ? [extra.id] : []);
    const emails = new Set();
    ids.forEach((id) => {
      const r = d.rows.find((x) => x.id === id);
      if (r && r.email && r.estat !== "Pendent") emails.add(String(r.email).toLowerCase());
    });
    return { ok: true, sent: emails.size };
  }
  if (action === "admin_update") {
    const r = d.rows.find((x) => x.id === extra.id);
    if (r) {
      const p = extra.patch || {};
      if (p.email != null) r.email = p.email;
      if (p.telefon != null) r.telefon = p.telefon;
      return { ok: true, id: extra.id, updated: p };
    }
    return { ok: false, error: "row not found" };
  }
  if (action === "admin_cancel") {
    const i = d.rows.findIndex((x) => x.id === extra.id);
    if (i >= 0) { d.rows.splice(i, 1); return { ok: true, id: extra.id }; }
    return { ok: false, error: "row not found" };
  }
  throw new Error("unknown action");
}
