/* ============================================================
   Campus d'Hoquei — Panell d'administració (frontend)

   Es comunica amb el mateix Apps Script que el formulari, però per
   endpoints d'administració protegits per PIN (Ajustes → admin_pin).
   Totes les peticions van per POST amb { action, pin, ... }.

   SCRIPT_URL buit = MODE DEMO amb dades d'exemple generades.
   ============================================================ */

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxNyjCaVv3J6qg--enkktrreZAmjHL00gJXa_6ym0wme1VJnkAC88gGJbaaukBccE5Tqg/exec";

const PIN_KEY = "casal_admin_pin";
const DEMO_PIN = "1234";

// Colors fixos dels grups (vestidors). Els intervals d'edat són configurables.
const GROUP_HEX = { blau: "#1F5AE0", verd: "#16A34A", taronja: "#D97706", vermell: "#DC2626" };
const GROUP_LABEL = { blau: "Blau", verd: "Verd", taronja: "Taronja", vermell: "Vermell" };
const DEFAULT_GROUPS = [
  { color: "blau", label: "Blau", min: 4, max: 6 },
  { color: "vermell", label: "Vermell", min: 7, max: 9 },
  { color: "taronja", label: "Taronja", min: 10, max: 11 },
  { color: "verd", label: "Verd", min: 12, max: 14 }
];

// ---- Estat ----
const state = {
  pin: "",
  form: "",
  forms: [],
  overview: null,
  list: [],
  filtered: [],
  sort: { key: "ts", dir: "desc" },
  filters: { q: "", week: "", status: "" },
  groups: DEFAULT_GROUPS.slice(),
  groupWeek: ""
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n) => `${Math.round(Number(n) || 0).toLocaleString("ca-ES")} €`;

document.addEventListener("DOMContentLoaded", init);

function init() {
  $("login-form").addEventListener("submit", onLogin);
  $("logout-btn").addEventListener("click", logout);
  $("refresh-btn").addEventListener("click", () => loadAll(true));
  $("form-select").addEventListener("change", (e) => { state.form = e.target.value; loadAll(); });
  $("search").addEventListener("input", (e) => { state.filters.q = e.target.value.toLowerCase(); applyFilters(); });
  $("filter-week").addEventListener("change", (e) => { state.filters.week = e.target.value; applyFilters(); });
  $("filter-status").addEventListener("change", (e) => { state.filters.status = e.target.value; applyFilters(); });
  $("export-btn").addEventListener("click", exportCsv);
  $("groups-config-btn").addEventListener("click", toggleGroupsConfig);
  $("drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  document.querySelectorAll(".dtable th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => toggleSort(th.dataset.sort)));

  const saved = sessionStorage.getItem(PIN_KEY);
  if (saved) { state.pin = saved; enter(); } else { $("pin").focus(); }
}

// ---- API ----
async function api(action, extra) {
  if (!SCRIPT_URL) return demoApi(action, extra);
  const body = Object.assign({ action, pin: state.pin, form: state.form }, extra || {});
  const res = await fetch(SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "error");
  return out;
}

// ---- Login ----
async function onLogin(e) {
  e.preventDefault();
  const pin = $("pin").value.trim();
  if (!pin) return;
  state.pin = pin;
  const btn = $("login-btn"); btn.classList.add("is-loading"); btn.disabled = true;
  $("login-note").textContent = "";
  try {
    const out = await api("admin_login");
    // El login vàlid sempre porta la llista de formularis. Si no hi és, el backend
    // desplegat és l'antic (sense panell) i acceptaria qualsevol codi: ho bloquegem.
    if (!out.forms) throw new Error("not-deployed");
    sessionStorage.setItem(PIN_KEY, pin);
    state.forms = out.forms || [];
    if (out.settings && out.settings.nombre_campus) {
      document.querySelectorAll("[data-camp-name]").forEach((n) => (n.textContent = out.settings.nombre_campus));
    }
    enter();
  } catch (err) {
    state.pin = "";
    $("login-note").textContent = err.message === "unauthorized"
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
    try { const out = await api("admin_login"); state.forms = out.forms || []; if (out.settings) document.querySelectorAll("[data-camp-name]").forEach((n) => (n.textContent = out.settings.nombre_campus || n.textContent)); }
    catch (err) { return logout(); }
  }
  renderFormSelect();
  state.form = state.forms[0] ? state.forms[0].id : "";
  $("form-select").value = state.form;
  loadAll();
}

function logout() {
  sessionStorage.removeItem(PIN_KEY);
  state.pin = "";
  $("app").hidden = true;
  $("login").hidden = false;
  $("pin").value = "";
  $("pin").focus();
}

function renderFormSelect() {
  const sel = $("form-select");
  sel.innerHTML = state.forms.map((f) => `<option value="${esc(f.id)}">${esc(f.nombre || f.id)}</option>`).join("");
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
    state.groups = (ov.groups && ov.groups.length) ? ov.groups : DEFAULT_GROUPS.slice();
    renderOverview();
    renderWeekFilter();
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
  euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5a6.5 6.5 0 1 0 0 15M4 9h7M4 14h6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
};

function renderOverview() {
  renderKpis(true);
  renderOccupancy();
  renderTimeline();
  renderPayments();
  renderAges();
  renderDiscounts();
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
  const box = $("chart-occupancy");
  if (!weeks.length) { box.innerHTML = '<p class="card__hint">Sense setmanes configurades.</p>'; $("occ-hint").textContent = ""; return; }
  const totalInscrits = weeks.reduce((s, w) => s + w.inscrits, 0);
  $("occ-hint").textContent = `${totalInscrits} places ocupades`;
  box.innerHTML = weeks.map((w) => {
    const hasLimit = w.plazas != null;
    const pct = hasLimit && w.plazas > 0 ? Math.min(100, Math.round((w.inscrits / w.plazas) * 100)) : 0;
    let cls = "is-nolimit";
    if (hasLimit) cls = pct >= 100 ? "is-full" : pct >= 80 ? "is-high" : "";
    const countTxt = hasLimit ? `<b>${w.inscrits}</b> / ${w.plazas}` : `<b>${w.inscrits}</b> inscrits`;
    return `<div class="occ__row">
      <div class="occ__top">
        <span><span class="occ__name">${esc(w.etiqueta || w.id)}</span> <span class="occ__dates">${esc(w.fechas || "")}</span></span>
        <span class="occ__count">${countTxt}${hasLimit ? ` · ${pct}%` : ""}</span>
      </div>
      <div class="occ__track"><div class="occ__bar ${cls}" data-w="${hasLimit ? pct : Math.min(100, w.inscrits * 8)}"></div></div>
    </div>`;
  }).join("");
  requestAnimationFrame(() => box.querySelectorAll(".occ__bar").forEach((b) => (b.style.width = b.dataset.w + "%")));
}

/* ============================================================
   RENDER — Inscripcions per dia (area chart SVG)
   ============================================================ */
function renderTimeline() {
  const data = (state.overview.perDay || []).slice();
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
function groupColorOf(row, week) {
  return (row.grups && row.grups[week]) || autoGroupColor(Number(row.edat));
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
  renderGroupsConfig();
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
      const manual = r.grups && r.grups[week];
      const noSwim = r.sapNedar && !/^(s|y|1|tru|ok)/i.test(String(r.sapNedar).trim());
      const opts = groups.map((gg) => `<option value="${esc(gg.color)}"${gg.color === g.color ? " selected" : ""}>${esc(gg.label)}</option>`).join("");
      return `<div class="gchip${manual ? " gchip--manual" : ""}" title="${manual ? "Mogut manualment" : "Assignat per edat"}">
        <span class="gchip__name">${esc(r.nom || "—")}</span>
        <span class="gchip__age">${r.edat !== "" ? r.edat + "a" : ""}</span>
        ${noSwim ? '<span class="gchip__noswim" title="No sap nedar">🚱</span>' : ""}
        <select class="gchip__move" data-move="${esc(r.id)}" aria-label="Mou de grup">${opts}</select>
      </div>`;
    }).join("");
    return `<div class="gcol" style="--gc:${hex}">
      <div class="gcol__head"><span class="gcol__dot"></span><span class="gcol__name">${esc(g.label)}</span><span class="gcol__count">${list.length}</span></div>
      <div class="gcol__range">${g.min}–${g.max} anys</div>
      <div class="gcol__list">${chips || '<p class="gcol__empty">Cap nen/a</p>'}</div>
    </div>`;
  }).join("");

  $("groups-board").querySelectorAll("[data-move]").forEach((sel) =>
    sel.addEventListener("change", () => setGroup(sel.dataset.move, week, sel.value)));
}

async function setGroup(id, week, color) {
  const row = state.list.find((r) => r.id === id);
  if (!row) return;
  const auto = autoGroupColor(Number(row.edat));
  row.grups = row.grups || {};
  if (!color || color === auto) delete row.grups[week]; else row.grups[week] = color;
  renderGroupsBoard(); // actualització optimista
  try { await api("admin_set_group", { id, week, color }); }
  catch (err) { toast("No s'ha pogut moure: " + err.message, true); loadAll(); }
}

function toggleGroupsConfig() {
  const box = $("groups-config");
  box.hidden = !box.hidden;
  if (!box.hidden) renderGroupsConfig(true);
}
function renderGroupsConfig(force) {
  const box = $("groups-config");
  if (box.hidden && !force) return;
  const groups = state.groups || DEFAULT_GROUPS;
  box.innerHTML = `<p class="groups-config__hint">Assignació automàtica per edat. Els canvis manuals sempre tenen prioritat.</p>
    <div class="groups-config__rows">` +
    groups.map((g) => `<div class="gconf-row" data-color="${esc(g.color)}">
      <span class="gconf-dot" style="background:${GROUP_HEX[g.color] || "#64748B"}"></span>
      <span class="gconf-name">${esc(g.label)}</span>
      <input class="gconf-min" type="number" min="0" max="99" value="${g.min}">
      <span>–</span>
      <input class="gconf-max" type="number" min="0" max="99" value="${g.max}">
      <span class="cell-sub">anys</span>
    </div>`).join("") +
    `</div><div class="groups-config__actions"><button class="btn btn--primary btn--sm" id="gconf-save">Desa els intervals</button></div>`;
  $("gconf-save").addEventListener("click", saveGroupsConfig);
}
async function saveGroupsConfig() {
  const config = [...$("groups-config").querySelectorAll(".gconf-row")].map((r) => ({
    color: r.dataset.color,
    min: Number(r.querySelector(".gconf-min").value) || 0,
    max: Number(r.querySelector(".gconf-max").value) || 99
  }));
  try {
    const out = await api("admin_set_groups_config", { config });
    state.groups = (out.groups && out.groups.length) ? out.groups
      : config.map((c) => ({ ...c, label: GROUP_LABEL[c.color] || c.color }));
    toast("Intervals desats.");
    renderGroups();
    renderAges();
  } catch (err) { toast("No s'ha pogut desar: " + err.message, true); }
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

function applyFilters() {
  const { q, week, status } = state.filters;
  state.filtered = state.list.filter((r) => {
    if (status && r.estat !== status) return false;
    if (week && !(r.weekIds || []).includes(week)) return false;
    if (q) {
      const hay = `${r.nom} ${r.tutor} ${r.email} ${r.telefon}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  sortRows();
  renderTable();
}

function toggleSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  else { state.sort.key = key; state.sort.dir = key === "ts" || key === "preu" ? "desc" : "asc"; }
  sortRows();
  renderTable();
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

function renderTable() {
  const tbody = $("tbody");
  const rows = state.filtered;
  $("table-empty").hidden = rows.length > 0;
  tbody.innerHTML = rows.map((r, i) => {
    const pills = (r.weekIds || []).map((w) => {
      const isPaid = (r.paidWeeks || []).includes(w);
      return `<span class="wpill${isPaid ? " wpill--paid" : ""}" title="${isPaid ? "Pagada" : "Pendent"}">${esc(w)}</span>`;
    }).join("");
    return `<tr data-i="${i}">
      <td>${esc(fmtDate(r.ts))}</td>
      <td><div class="cell-name">${esc(r.nom || "—")}</div>${r.edat !== "" ? `<div class="cell-sub">${r.edat} anys</div>` : ""}</td>
      <td>${esc(r.tutor || "—")}<div class="cell-sub">${esc(r.email || "")}</div></td>
      <td class="hide-sm"><div class="weeks-pills">${pills || "—"}</div></td>
      <td class="num">${r.preu ? eur(r.preu) : "—"}</td>
      <td>${estatBadge(r, true)}</td>
      <td><div class="row-actions">
        <button class="iconbtn" data-resend="${esc(r.id)}" title="Reenviar correu" aria-label="Reenviar correu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z" opacity="0"/><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></button>
      </div></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-toggle]") || e.target.closest("[data-resend]")) return;
      openDrawer(state.filtered[Number(tr.dataset.i)]);
    });
  });
  tbody.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleAllPaid(b.dataset.toggle); }));
  tbody.querySelectorAll("[data-resend]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); resend(b.dataset.resend); }));
}

// Etiqueta d'estat de pagament. clickable=true → botó que marca/desmarca totes les setmanes.
function estatBadge(r, clickable) {
  const reg = (r.weekIds || []).length;
  const paid = (r.paidWeeks || []).filter((w) => (r.weekIds || []).includes(w)).length;
  let cls = "estat--pendent", label = "Pendent";
  if (r.estat === "Pagat") { cls = "estat--pagat"; label = "Pagat"; }
  else if (r.estat === "Parcial") { cls = "estat--parcial"; label = `Parcial ${paid}/${reg}`; }
  const attr = clickable ? ` data-toggle="${esc(r.id)}" title="Marcar/desmarcar totes les setmanes"` : "";
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
async function setPayment(id, weeks, opts) {
  const row = state.list.find((r) => r.id === id);
  if (!row) return;
  const prev = { paidWeeks: row.paidWeeks, estat: row.estat };
  // Actualització optimista: la UI respon a l'instant; després confirmem amb el servidor.
  const paid = (weeks || []).filter((w) => (row.weekIds || []).includes(w));
  row.paidWeeks = paid;
  row.estat = paid.length === 0 ? "Pendent" : paid.length >= (row.weekIds || []).length ? "Pagat" : "Parcial";
  recomputePayments();
  applyFilters();
  if (opts && opts.reopen) openDrawer(row);
  try {
    const out = await api("admin_set_payment", { id, weeks });
    row.paidWeeks = out.paidWeeks || paid;
    row.estat = out.estat;
  } catch (err) {
    row.paidWeeks = prev.paidWeeks; row.estat = prev.estat;
    recomputePayments(); applyFilters();
    toast("No s'ha pogut actualitzar: " + err.message, true);
  }
}

// Botó d'estat de la taula: marca totes les setmanes o cap (alterna).
function toggleAllPaid(id, opts) {
  const row = state.list.find((r) => r.id === id);
  if (!row) return;
  const reg = (row.weekIds || []);
  const allPaid = reg.length > 0 && reg.every((w) => (row.paidWeeks || []).includes(w));
  setPayment(id, allPaid ? [] : reg.slice(), opts);
}

// Alterna una setmana concreta (des del calaix de detall).
function toggleWeekPaid(id, weekId) {
  const row = state.list.find((r) => r.id === id);
  if (!row) return;
  const paid = new Set(row.paidWeeks || []);
  paid.has(weekId) ? paid.delete(weekId) : paid.add(weekId);
  setPayment(id, [...paid], { reopen: true });
}

function recomputePayments() {
  const o = state.overview; if (!o) return;
  let pagat = 0, parcial = 0, pendent = 0, cobrats = 0;
  state.list.forEach((r) => {
    const reg = (r.weekIds || []).length;
    const paid = (r.paidWeeks || []).filter((w) => (r.weekIds || []).includes(w)).length;
    if (r.estat === "Pagat") pagat++;
    else if (r.estat === "Parcial") parcial++;
    else pendent++;
    if (reg) cobrats += (Number(r.preu) || 0) * (paid / reg);
  });
  o.payments = { Pagat: pagat, Parcial: parcial, Pendent: pendent };
  o.kpis.ingressos_cobrats = Math.round(cobrats);
  o.kpis.ingressos_pendents = Math.round((o.kpis.ingressos_total || 0) - cobrats);
  // Només actualitzem el que canvia en marcar pagaments: KPIs (sense reanimar) i el donut.
  renderKpis(false);
  renderPayments();
}

async function resend(id) {
  if (!confirm("Reenviar el correu de confirmació d'aquesta inscripció?")) return;
  try {
    const out = await api("admin_resend", { id });
    toast(out.to ? `Correu reenviat a ${out.to}.` : "Correu reenviat.");
  } catch (err) {
    toast("No s'ha pogut reenviar: " + err.message, true);
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
  </div>`;

  $("drawer-body").innerHTML = html;
  const payAll = $("drawer-body").querySelector("[data-payall]");
  if (payAll) payAll.addEventListener("click", () => toggleAllPaid(r.id, { reopen: true }));
  $("drawer-body").querySelectorAll("[data-payweek]").forEach((b) =>
    b.addEventListener("click", () => toggleWeekPaid(r.id, b.dataset.payweek)));
  $("dw-resend").addEventListener("click", () => resend(r.id));

  $("drawer-backdrop").hidden = false;
  $("drawer").hidden = false;
}

function closeDrawer() {
  $("drawer").hidden = true;
  $("drawer-backdrop").hidden = true;
}

/* ============================================================
   Export CSV
   ============================================================ */
function exportCsv() {
  const rows = state.filtered;
  if (!rows.length) return toast("No hi ha res per exportar.", true);
  const cols = ["ID", "Data", "Jugador/a", "Edat", "Tutor/a", "Email", "Telèfon", "Setmanes", "Preu", "Descompte", "Estat"];
  const lines = [cols.join(";")];
  rows.forEach((r) => {
    const vals = [r.id, fmtDate(r.ts), r.nom, r.edat, r.tutor, r.email, r.telefon, r.setmanes, r.preu, r.descompte, r.estat];
    lines.push(vals.map(csvCell).join(";"));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `inscripcions_${state.form || "campus"}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`${rows.length} files exportades.`);
}
function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
  { id: "estiu", nombre: "Casal d'Estiu 2026" },
  { id: "primavera", nombre: "Casal de Primavera 2027" },
  { id: "hivern", nombre: "Casal de Nadal 2026" }
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
        { label: "Nom i cognoms", value: nom, grup: "Dades del jugador/a", esJugador: true },
        { label: "Data de naixement", value: `1${i % 9}/0${1 + i % 8}/20${10 + i % 9}`, grup: "Dades del jugador/a", esJugador: true },
        { label: "Sap nedar?", value: swim, grup: "Dades del jugador/a", esJugador: true },
        ...(card ? [{ label: "Còpia de la targeta sanitària", value: card, grup: "Documentació", esJugador: true }] : []),
        { label: "Nom del tutor/a", value: tutors[i % tutors.length], grup: "Dades del tutor/a", esJugador: false },
        { label: "Telèfon", value: "6" + (10000000 + Math.floor(Math.random() * 8999999)), grup: "Dades del tutor/a", esJugador: false }
      ]
    });
  }
  const perDay = {}; rows.forEach((r) => (perDay[r.ts] = (perDay[r.ts] || 0) + 1));
  const ages = {}; rows.forEach((r) => (ages[r.edat] = (ages[r.edat] || 0) + 1));
  _demo[form] = { weeks, occ, rows, perDay, ages };
  return _demo[form];
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
    if (state.pin !== DEMO_PIN) throw new Error("unauthorized");
    return { ok: true, forms: DEMO_FORMS, settings: { nombre_campus: "Campus d'Hoquei Riudebitlles", club: "El plaer de jugar!" } };
  }
  const d = demoData(state.form);
  if (action === "admin_data") {
    return { ok: true, overview: demoOverview(d), list: d.rows.slice().reverse() };
  }
  if (action === "admin_overview") return demoOverview(d);
  if (action === "admin_list") return { ok: true, form: state.form, rows: d.rows.slice().reverse() };
  if (action === "admin_set_group") {
    const r = d.rows.find((x) => x.id === extra.id);
    if (r) {
      r.grups = r.grups || {};
      const auto = autoGroupColor(Number(r.edat));
      if (!extra.color || extra.color === auto) delete r.grups[extra.week]; else r.grups[extra.week] = extra.color;
      return { ok: true, id: extra.id, grups: r.grups };
    }
    return { ok: false, error: "row not found" };
  }
  if (action === "admin_set_groups_config") {
    _demoGroups = (extra.config || []).map((c) => ({ color: c.color, label: GROUP_LABEL[c.color] || c.color, min: Number(c.min) || 0, max: Number(c.max) || 99 }));
    return { ok: true, groups: _demoGroups };
  }
  if (action === "admin_set_payment") {
    const r = d.rows.find((x) => x.id === extra.id);
    if (r) {
      const paid = (extra.weeks || []).filter((w) => (r.weekIds || []).includes(w));
      r.paidWeeks = paid;
      r.estat = paid.length === 0 ? "Pendent" : paid.length >= (r.weekIds || []).length ? "Pagat" : "Parcial";
      return { ok: true, id: extra.id, estat: r.estat, paidWeeks: paid };
    }
    return { ok: false, error: "row not found" };
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
  throw new Error("unknown action");
}
