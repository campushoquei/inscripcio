/* ============================================================
   Campus d'Hoquei — Panell d'administració (frontend)

   Es comunica amb el mateix Apps Script que el formulari, però per
   endpoints d'administració protegits per PIN (Ajustes → admin_pin).
   Totes les peticions van per POST amb { action, pin, ... }.

   SCRIPT_URL buit = MODE DEMO amb dades d'exemple generades.
   ============================================================ */

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxs2yS4-90ziGdsU9Z_cfCK6-FlJVzFTN-sKvxSIm1UlvcpWJspZyik4Y95GSCRSSAeOA/exec";

const PIN_KEY = "casal_admin_pin";
const DEMO_PIN = "1234";

// ---- Estat ----
const state = {
  pin: "",
  form: "",
  forms: [],
  overview: null,
  list: [],
  filtered: [],
  sort: { key: "ts", dir: "desc" },
  filters: { q: "", week: "", status: "" }
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
    const [ov, ls] = await Promise.all([api("admin_overview"), api("admin_list")]);
    state.overview = ov;
    state.list = ls.rows || [];
    renderOverview();
    renderWeekFilter();
    applyFilters();
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
  const k = state.overview.kpis;
  const cards = [
    { icon: ICONS.players, value: k.jugadors, label: "Jugadors/es inscrits", sub: `${k.enviaments} inscripcions enviades`, accent: "#1F5AE0", soft: "#E5EDFC" },
    { icon: ICONS.family, value: k.families, label: "Famílies", sub: `${k.preu_mitja ? eur(k.preu_mitja) + " de mitjana" : ""}`, accent: "#7C3AED", soft: "#EDE7FB" },
    { icon: ICONS.euro, value: k.ingressos_total, unit: "€", label: "Ingressos totals", sub: `${eur(k.ingressos_cobrats)} cobrats`, accent: "#16A34A", soft: "#DCFCE7", money: true },
    { icon: ICONS.clock, value: k.ingressos_pendents, unit: "€", label: "Pendents de cobrar", sub: `${state.overview.payments.Pendent} inscripcions`, accent: "#D97706", soft: "#FEF3C7", money: true }
  ];
  $("kpis").innerHTML = cards.map((c) => `
    <div class="kpi" style="--accent:${c.accent};--accent-soft:${c.soft}">
      <div class="kpi__icon">${c.icon}</div>
      <div class="kpi__value" data-count="${c.value}" data-money="${c.money ? 1 : 0}">0${c.unit ? `<span class="unit">${c.unit}</span>` : ""}</div>
      <div class="kpi__label">${esc(c.label)}</div>
      <div class="kpi__sub">${esc(c.sub)}</div>
    </div>`).join("");
  document.querySelectorAll(".kpi__value[data-count]").forEach((el) => countUp(el));

  renderOccupancy();
  renderTimeline();
  renderPayments();
  renderAges();
  renderDiscounts();
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
  const p = state.overview.payments || { Pagat: 0, Pendent: 0 };
  const total = p.Pagat + p.Pendent;
  const segs = [
    { name: "Pagat", val: p.Pagat, color: "#16A34A" },
    { name: "Pendent", val: p.Pendent, color: "#D97706" }
  ];
  const r = 52, c = 2 * Math.PI * r, cx = 70, cy = 70;
  let offset = 0;
  const circles = total === 0
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#EEF3FB" stroke-width="18"/>`
    : segs.map((s) => {
        const len = (s.val / total) * c;
        const el = `<circle class="donut__seg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="butt"/>`;
        offset += len;
        return el;
      }).join("");
  const pctPaid = total ? Math.round((p.Pagat / total) * 100) : 0;
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
  box.innerHTML = ages.map((a) =>
    `<div class="chart-bars__col">
      <div class="chart-bars__bar" data-h="${Math.round((a.count / max) * 100)}"><span class="chart-bars__val">${a.count}</span></div>
      <span class="chart-bars__lbl">${a.age}</span>
    </div>`).join("");
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
   RENDER — Taula
   ============================================================ */
function renderWeekFilter() {
  const weeks = state.overview.weeks || [];
  const sel = $("filter-week");
  sel.innerHTML = `<option value="">Totes les setmanes</option>` +
    weeks.map((w) => `<option value="${esc(w.id)}">${esc(w.etiqueta || w.id)}</option>`).join("");
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
    const pills = (r.weekIds || []).map((w) => `<span class="wpill">${esc(w)}</span>`).join("");
    const estatCls = r.estat === "Pagat" ? "estat--pagat" : "estat--pendent";
    return `<tr data-i="${i}">
      <td>${esc(fmtDate(r.ts))}</td>
      <td><div class="cell-name">${esc(r.nom || "—")}</div>${r.edat !== "" ? `<div class="cell-sub">${r.edat} anys</div>` : ""}</td>
      <td>${esc(r.tutor || "—")}<div class="cell-sub">${esc(r.email || "")}</div></td>
      <td class="hide-sm"><div class="weeks-pills">${pills || "—"}</div></td>
      <td class="num">${r.preu ? eur(r.preu) : "—"}</td>
      <td><button class="estat ${estatCls}" data-toggle="${esc(r.id)}"><span class="estat__dot"></span>${r.estat}</button></td>
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
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleStatus(b.dataset.toggle, b); }));
  tbody.querySelectorAll("[data-resend]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); resend(b.dataset.resend); }));
}

function fmtDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/* ============================================================
   Accions de fila
   ============================================================ */
async function toggleStatus(id, btn) {
  const row = state.list.find((r) => r.id === id);
  if (!row) return;
  const next = row.estat === "Pagat" ? "Pendent" : "Pagat";
  btn.style.opacity = ".5"; btn.disabled = true;
  try {
    await api("admin_set_status", { id, estat: next });
    row.estat = next;
    // refresca KPIs de cobrament localment
    recomputePayments();
    applyFilters();
    toast(`Marcat com a ${next.toLowerCase()}.`);
  } catch (err) {
    toast("No s'ha pogut actualitzar: " + err.message, true);
    btn.style.opacity = ""; btn.disabled = false;
  }
}

function recomputePayments() {
  const o = state.overview; if (!o) return;
  let pagat = 0, pendent = 0, cobrats = 0;
  state.list.forEach((r) => {
    if (r.estat === "Pagat") { pagat++; cobrats += Number(r.preu) || 0; }
    else pendent++;
  });
  o.payments = { Pagat: pagat, Pendent: pendent };
  o.kpis.ingressos_cobrats = Math.round(cobrats);
  o.kpis.ingressos_pendents = Math.round((o.kpis.ingressos_total || 0) - cobrats);
  renderOverview();
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
    <div class="dfield"><span class="dfield__k">Setmanes</span><span class="dfield__v">${esc(r.setmanes || "—")}</span></div>
    <div class="dfield"><span class="dfield__k">Estat</span><span class="dfield__v">${esc(r.estat)}</span></div>
  </div>`;

  Object.keys(groups).forEach((g) => {
    html += `<div class="dgroup"><div class="dgroup__title">${esc(g)}</div>` +
      groups[g].map((d) => {
        const v = /^https?:\/\//.test(d.value) ? `<a href="${esc(d.value)}" target="_blank" rel="noopener">Veure document</a>` : esc(d.value);
        return `<div class="dfield"><span class="dfield__k">${esc(d.label)}</span><span class="dfield__v">${v}</span></div>`;
      }).join("") + `</div>`;
  });

  if (r.fitxers && r.fitxers.length) {
    html += `<div class="dgroup"><div class="dgroup__title">Documents (${r.fitxers.length})</div>` +
      r.fitxers.map((u, i) => `<div class="dfield"><span class="dfield__k">Fitxer ${i + 1}</span><span class="dfield__v"><a href="${esc(u)}" target="_blank" rel="noopener">Obrir</a></span></div>`).join("") +
      `</div>`;
  }

  html += `<div class="drawer__actions">
    <button class="btn btn--primary btn--sm" id="dw-status">${r.estat === "Pagat" ? "Marcar pendent" : "Marcar pagat"}</button>
    <button class="btn btn--ghost btn--sm" id="dw-resend">Reenviar correu</button>
  </div>`;

  $("drawer-body").innerHTML = html;
  $("dw-status").addEventListener("click", async () => { await toggleStatusFromDrawer(r); });
  $("dw-resend").addEventListener("click", () => resend(r.id));

  $("drawer-backdrop").hidden = false;
  $("drawer").hidden = false;
}

async function toggleStatusFromDrawer(r) {
  const next = r.estat === "Pagat" ? "Pendent" : "Pagat";
  try {
    await api("admin_set_status", { id: r.id, estat: next });
    r.estat = next;
    const row = state.list.find((x) => x.id === r.id);
    if (row) row.estat = next;
    recomputePayments();
    applyFilters();
    openDrawer(r);
    toast(`Marcat com a ${next.toLowerCase()}.`);
  } catch (err) { toast("Error: " + err.message, true); }
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
let _demo = null;
function demoData() {
  if (_demo) return _demo;
  const noms = ["Marc Puig", "Laia Soler", "Jan Vidal", "Aina Roca", "Pol Ferrer", "Júlia Mas", "Bruna Costa", "Nil Serra", "Ona Vila", "Roc Camps", "Èlia Pujol", "Arnau Bosch", "Mar Riba", "Biel Font", "Carla Sala", "Pau Llopis", "Vera Grau", "Guim Soto", "Noa Prat", "Roger Coll"];
  const tutors = ["Anna Puig", "David Soler", "Marta Vidal", "Jordi Roca", "Sara Ferrer", "Albert Mas"];
  const weeks = [
    { id: "S1", etiqueta: "Setmana 1", fechas: "29 juny – 3 jul", plazas: 25 },
    { id: "S2", etiqueta: "Setmana 2", fechas: "6 – 10 jul", plazas: 25 },
    { id: "S3", etiqueta: "Setmana 3", fechas: "13 – 17 jul", plazas: 20 },
    { id: "S4", etiqueta: "Setmana 4", fechas: "20 – 24 jul", plazas: 25 },
    { id: "S5", etiqueta: "Setmana 5", fechas: "27 – 31 jul", plazas: 25 }
  ];
  const rows = []; const occ = {};
  weeks.forEach((w) => (occ[w.id] = 0));
  for (let i = 0; i < 34; i++) {
    const nom = noms[i % noms.length] + (i >= noms.length ? " " + (i) : "");
    const wsel = weeks.filter(() => Math.random() > 0.55);
    if (!wsel.length) wsel.push(weeks[i % weeks.length]);
    const rdb = Math.random() > 0.6, fn = Math.random() > 0.85;
    const preu = wsel.reduce((s, _, idx) => s + (idx === 0 ? (rdb ? 70 : 80) : (rdb ? 60 : 70)), 0);
    const desc = [rdb && "C.P. Riudebitlles", fn && "Família nombrosa"].filter(Boolean).join(", ") || "-";
    wsel.forEach((w) => occ[w.id]++);
    const day = new Date(2026, 4, 1 + Math.floor(i / 1.6));
    rows.push({
      id: "INS-" + (1700000000000 + i * 99000) + (Math.random() > 0.8 ? "-1" : ""),
      baseId: "INS-" + i, row: i + 2, ts: day.toISOString().slice(0, 10),
      formulario: "Casal d'Estiu 2026", nom,
      tutor: tutors[i % tutors.length], email: nom.toLowerCase().replace(/\s+/g, ".") + "@exemple.cat",
      telefon: "6" + (10000000 + Math.floor(Math.random() * 8999999)),
      edat: 6 + (i % 8), setmanes: wsel.map((w) => w.id).join(", "),
      weekIds: wsel.map((w) => w.id), preu, descompte: desc,
      estat: Math.random() > 0.45 ? "Pagat" : "Pendent",
      fitxers: Math.random() > 0.6 ? ["https://drive.google.com/exemple"] : [],
      detall: [
        { label: "Nom i cognoms", value: nom, grup: "Dades del jugador/a", esJugador: true },
        { label: "Data de naixement", value: `1${i % 9}/0${1 + i % 8}/20${10 + i % 9}`, grup: "Dades del jugador/a", esJugador: true },
        { label: "Sap nedar?", value: Math.random() > 0.3 ? "Sí" : "No", grup: "Dades del jugador/a", esJugador: true },
        { label: "Nom del tutor/a", value: tutors[i % tutors.length], grup: "Dades del tutor/a", esJugador: false },
        { label: "Telèfon", value: "6" + (10000000 + Math.floor(Math.random() * 8999999)), grup: "Dades del tutor/a", esJugador: false }
      ]
    });
  }
  const perDay = {}; rows.forEach((r) => (perDay[r.ts] = (perDay[r.ts] || 0) + 1));
  const ages = {}; rows.forEach((r) => (ages[r.edat] = (ages[r.edat] || 0) + 1));
  _demo = { weeks, occ, rows, perDay, ages };
  return _demo;
}

async function demoApi(action, extra) {
  await new Promise((r) => setTimeout(r, 280));
  const d = demoData();
  if (action === "admin_login") {
    if (state.pin !== DEMO_PIN) throw new Error("unauthorized");
    return { ok: true, forms: [{ id: "estiu", nombre: "Casal d'Estiu 2026" }, { id: "primavera", nombre: "Casal de Primavera 2027" }], settings: { nombre_campus: "Campus d'Hoquei Riudebitlles", club: "El plaer de jugar!" } };
  }
  if (action === "admin_overview") {
    let total = 0, cobrats = 0, pagat = 0, pendent = 0;
    const disc = { rdb: 0, fn: 0, germa: 0, cap: 0 };
    d.rows.forEach((r) => {
      total += r.preu;
      if (r.estat === "Pagat") { cobrats += r.preu; pagat++; } else pendent++;
      let any = false;
      if (/riudebitlles/i.test(r.descompte)) { disc.rdb++; any = true; }
      if (/nombrosa/i.test(r.descompte)) { disc.fn++; any = true; }
      if (/-1$/.test(r.id)) { disc.germa++; any = true; }
      if (!any) disc.cap++;
    });
    const families = new Set(d.rows.map((r) => r.tutor)).size;
    return {
      ok: true, form: state.form, generatedAt: new Date().toISOString(),
      kpis: { jugadors: d.rows.length, enviaments: d.rows.length - 3, families, ingressos_total: total, ingressos_cobrats: cobrats, ingressos_pendents: total - cobrats, preu_mitja: Math.round(total / d.rows.length) },
      weeks: d.weeks.map((w) => ({ id: w.id, etiqueta: w.etiqueta, fechas: w.fechas, plazas: w.plazas, inscrits: d.occ[w.id] })),
      perDay: Object.keys(d.perDay).sort().map((k) => ({ date: k, count: d.perDay[k] })),
      ages: Object.keys(d.ages).map(Number).sort((a, b) => a - b).map((a) => ({ age: a, count: d.ages[a] })),
      discounts: disc, payments: { Pagat: pagat, Pendent: pendent },
      recent: d.rows.slice(-8).reverse()
    };
  }
  if (action === "admin_list") return { ok: true, form: state.form, rows: d.rows.slice().reverse() };
  if (action === "admin_set_status") {
    const r = d.rows.find((x) => x.id === extra.id); if (r) r.estat = extra.estat;
    return { ok: true, id: extra.id, estat: extra.estat };
  }
  if (action === "admin_resend") {
    const r = d.rows.find((x) => x.id === extra.id);
    return { ok: true, id: extra.id, to: r ? r.email : "" };
  }
  throw new Error("unknown action");
}
