/* ============================================================
   Casal d'hoquei — Backend (Google Apps Script)

   Script LLIGAT al full: Extensions → Apps Script, enganxa això,
   Desplega → Aplicació web (executa com "Jo", accés "Qualsevol").
   Copia la URL /exec a SCRIPT_URL d'app.js.

   Pestanyes (vegeu SETUP.md):
     · Ajustes        (Clave | Valor)
     · Semanas        (id | etiqueta | fechas | precio | plazas | mostrar_plazas)   [campus opcional]
     · Campos         (id | etiqueta | tipo | opciones | obligatorio | placeholder | ayuda | grupo | orden)
     · Inscripciones  (automàtica: hi escriu 1 columna per setmana + edat)
     · Campus         (opcional, per a més endavant)
   ============================================================ */

var SHEETS = {
  settings: "Ajustes",
  campus: "Campus",
  weeks: "Semanas",
  fields: "Campos",
  subs: "Inscripciones",
  forms: "Formularios"
};

// Cau de lectures vàlida NOMÉS dins d'una mateixa petició HTTP. Evita rellegir
// el mateix full desenes de vegades (Inscripcions, Camps, Ajustes…), que és el
// que feia lent el panell. Es buida a l'inici de cada doGet/doPost.
var _cache = { tables: {}, subs: {} };
function resetCache() { _cache = { tables: {}, subs: {} }; }

/* ---------- Rate limiting & Seguretat d'admin ---------- */
var SUB_RATE_LIMIT  = 30;    // màx. enviaments per minut (global)
var ADMIN_MAX_FAILS = 5;     // intents fallits fins al bloqueig
var ADMIN_LOCK_SECS = 900;   // 15 minuts de bloqueig
var ADMIN_TOK_SECS  = 28800; // 8 hores de sessió

function checkSubmissionRateLimit() {
  var cache = CacheService.getScriptCache();
  var win   = Math.floor(Date.now() / 60000);
  var key   = "rl_" + win;
  var count = parseInt(cache.get(key) || "0");
  if (count >= SUB_RATE_LIMIT) return false;
  cache.put(key, String(count + 1), 120);
  return true;
}
function isAdminLocked() {
  return CacheService.getScriptCache().get("adm_lk") === "1";
}
function recordAdminFailure() {
  var cache = CacheService.getScriptCache();
  var fails = parseInt(cache.get("adm_f") || "0") + 1;
  if (fails >= ADMIN_MAX_FAILS) {
    cache.put("adm_lk", "1", ADMIN_LOCK_SECS);
    cache.remove("adm_f");
  } else {
    cache.put("adm_f", String(fails), ADMIN_LOCK_SECS);
  }
}
function clearAdminFailures() {
  var cache = CacheService.getScriptCache();
  cache.remove("adm_f");
  cache.remove("adm_lk");
}
function createAdminToken() {
  var tok = Utilities.getUuid();
  CacheService.getScriptCache().put("tok_" + tok, "1", ADMIN_TOK_SECS);
  return tok;
}
function validateAdminToken(tok) {
  if (!tok) return false;
  return CacheService.getScriptCache().get("tok_" + String(tok)) === "1";
}
function revokeAdminToken(tok) {
  if (tok) CacheService.getScriptCache().remove("tok_" + String(tok));
}

// Valida els camps de la inscripció al servidor. Retorna { ok } o { ok: false, error }.
function validatePayload(payload, entries) {
  var ALLOWED_MIME = {
    "image/jpeg": 1, "image/jpg": 1, "image/png": 1,
    "image/heic": 1, "image/webp": 1, "application/pdf": 1
  };
  var MAX_FILE_B  = 5  * 1024 * 1024; // 5 MB per fitxer
  var MAX_TOTAL_B = 12 * 1024 * 1024; // 12 MB en total

  var shared = payload.shared || {};

  // Email: obligatori i amb format bàsic vàlid.
  var email = findEmail(shared);
  if (!email) {
    for (var i = 0; i < (entries || []).length && !email; i++) email = findEmail((entries[i].data) || {});
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Adreça de correu electrònic no vàlida o absent." };
  }

  // NIF/NIE: si és present, validar format.
  var nif = pickFirstValue(shared, [/^nif$/i, /document/i, /dni/i]);
  if (nif && !/^\d{8}[A-Za-z]$|^[XYZxyz]\d{7}[A-Za-z]$/.test(str(nif).replace(/\s/g, ""))) {
    return { ok: false, error: "Format de NIF/NIE no vàlid." };
  }

  // Telèfon: si és present, validar format (7–15 caràcters numèrics/+/-/espai).
  var tel = pickFirstValue(shared, [/^telefon$|^telefono$|^mobil$|^movil$|^phone$/i]);
  if (tel && !/^[0-9\s+\-.]{7,15}$/.test(str(tel))) {
    return { ok: false, error: "Format de telèfon no vàlid." };
  }

  // Codi postal: si és present, ha de ser exactament 5 dígits.
  var cp = pickFirstValue(shared, [/codi_postal|codigo_postal|codipostal|postal_code/i]);
  if (cp && !/^\d{5}$/.test(str(cp).trim())) {
    return { ok: false, error: "El codi postal ha de tenir 5 dígits." };
  }

  // Fitxers: tipus MIME permès i mida màxima.
  var totalBytes = 0;
  for (var j = 0; j < (entries || []).length; j++) {
    var files = (entries[j] && entries[j].files) || [];
    for (var k = 0; k < files.length; k++) {
      var f = files[k];
      var mime = str(f.mimeType).toLowerCase();
      if (mime && !ALLOWED_MIME[mime]) {
        return { ok: false, error: "Tipus de fitxer no permès: " + mime };
      }
      var sz = f.dataBase64 ? Math.round(f.dataBase64.length * 0.75) : 0;
      if (sz > MAX_FILE_B) return { ok: false, error: "El fitxer \"" + str(f.name) + "\" supera els 5 MB." };
      totalBytes += sz;
    }
  }
  if (totalBytes > MAX_TOTAL_B) return { ok: false, error: "El total de fitxers adjunts supera els 12 MB." };

  return { ok: true };
}

function doGet(e) {
  resetCache();
  try {
    var form = (e && e.parameter && e.parameter.form) ? String(e.parameter.form).trim() : "";
    return json(buildConfig(form));
  }
  catch (err) { return json({ error: String(err) }); }
}

function doPost(e) {
  resetCache();
  // Router: les peticions del panell d'administració porten un camp "action".
  // Les processem abans d'agafar el lock perquè són lectures/edicions puntuals.
  var pre = null;
  try { pre = JSON.parse(e.postData.contents); } catch (_) { pre = null; }
  if (pre && pre.action) return json(handleAdmin(pre));

  if (!checkSubmissionRateLimit()) return json({ ok: false, error: "Massa sol·licituds. Espera un moment i torna-ho a provar." });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var payload = JSON.parse(e.postData.contents);
    var form = String(payload.form || "").trim();
    if (!form) { var g = readSettings(""); form = String(g.form_defecto || "").trim(); }
    payload.form = form;
    var baseId = "INS-" + new Date().getTime();
    var settings = readSettings(form);

    // Normalitza: sempre treballem amb una llista de jugadors/es ("entries").
    // Format nou  → { shared:{...}, children:[ {data, weeks, weekLabels, files}, ... ] }
    // Format antic → { data:{...}, weeks:[...], weekLabels:[...], files:[...] }  (un sol jugador/a)
    var shared = payload.shared || {};
    var entries = (payload.children && payload.children.length)
      ? payload.children
      : [{ data: payload.data || {}, weeks: payload.weeks || [], weekLabels: payload.weekLabels || [], files: payload.files || [] }];

    var v = validatePayload(payload, entries);
    if (!v.ok) return json({ ok: false, error: v.error });

    removeExistingSubmissionRows(form, shared);

    // Cada fill puja els seus propis fitxers i l'URL va només a la seva fila.
    var rows = [];
    entries.forEach(function (child, idx) {
      var id = baseId + (entries.length > 1 ? "-" + (idx + 1) : "");
      var cd = child.data || {};
      var childFiles = child.files || [];
      // Passa les dades del fill concret perquè el nom del fitxer reflecteixi el seu nom,
      // no sempre el del primer fill. També passem el formulari perquè els fitxers
      // es desin en una carpeta amb el nom del formulari (no a "General").
      var saved = saveFiles(childFiles, settings, { data: cd, formName: payload.formName, form: form }, id);
      var byField = {};
      saved.forEach(function (s) { (byField[s.field] = byField[s.field] || []).push(s.url); });

      var data = {};
      Object.keys(shared).forEach(function (k) { data[k] = shared[k]; });
      Object.keys(cd).forEach(function (k) { data[k] = cd[k]; });
      Object.keys(byField).forEach(function (k) { data[k] = byField[k].join("\n"); });
      if (!data.email) data.email = findEmail(shared) || findEmail(cd) || findEmail(payload.data || {}) || "";

      var rowPayload = {
        form: form, formName: payload.formName, campusId: payload.campusId, campusName: payload.campusName,
        weeks: child.weeks || [], weekLabels: child.weekLabels || [],
        preu: child.preu != null ? child.preu : null,
        descompte: child.descompte || ""
      };
      saveRow(id, rowPayload, data);
      rows.push({ id: id, data: data, weekLabels: child.weekLabels || [], savedFiles: saved });
    });

    sendConfirmation(settings, payload, rows);
    return json({ ok: true, id: baseId, count: entries.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Config ---------- */
function buildConfig(form) {
  form = String(form || "").trim();
  if (!form) { var g = readSettings(""); form = String(g.form_defecto || "").trim(); }
  var forms = readForms();
  var info = { id: form, nombre: "", habilitado: true };
  forms.forEach(function (f) { if (f.id === form) info = f; });
  return {
    settings: readSettings(form),
    campuses: readCampuses(),
    weeks: readWeeks(form),
    fields: readFields(form),
    form: { id: info.id, nombre: info.nombre, habilitado: info.habilitado, estacio: info.estacio },
    forms: forms.map(function (f) { return { id: f.id, nombre: f.nombre, habilitado: f.habilitado, estacio: f.estacio }; })
  };
}
// Files amb la columna "form" buida = compartides per tots els formularis.
// Files amb "form" = NOM s'apliquen (o sobreescriuen) només a aquell formulari.
function rowForm(r) { return String(r.form || r.Form || "").trim(); }
function rowMatchesForm(r, form) { var rf = rowForm(r); return !rf || rf === String(form || "").trim(); }

function readSettings(form) {
  form = String(form || "").trim();
  var base = {}, over = {};
  readTable(SHEETS.settings).forEach(function (r) {
    var k = String(r.Clave || r.clave || "").trim();
    if (!k) return;
    var v = coerce(r.Valor != null ? r.Valor : r.valor);
    var rf = rowForm(r);
    if (!rf) base[k] = v;
    else if (form && rf === form) over[k] = v;
  });
  Object.keys(over).forEach(function (k) { base[k] = over[k]; });
  return base;
}
function readForms() {
  return readTable(SHEETS.forms).filter(function (r) {
    return r.id || r.vs;
  }).map(function (r) {
    var id = str(r.id || r.vs);
    var hab = (r.habilitado == null || String(r.habilitado).trim() === "") ? true : truthy(r.habilitado);
    return { id: id, nombre: str(r.nombre), habilitado: hab, hoja: str(r.hoja), estacio: str(r.estacio) };
  });
}
function findForm(id) {
  id = String(id || "").trim();
  var forms = readForms();
  for (var i = 0; i < forms.length; i++) if (forms[i].id === id) return forms[i];
  return null;
}
// Cada formulari guarda les inscripcions a la seva pestanya.
// Formulari per defecte (buit) → "Inscripciones" (compatible amb el que ja tens).
function subsSheetName(form) {
  form = String(form || "").trim();
  if (!form) return SHEETS.subs;
  var f = findForm(form);
  if (f && f.hoja) return f.hoja;
  return SHEETS.subs + "_" + form.replace(/[^\w\-]+/g, "_");
}
function readCampuses() {
  return readTable(SHEETS.campus).filter(function (r) { return r.id; }).map(function (r) {
    return { id: String(r.id).trim(), nombre: str(r.nombre), fechas: str(r.fechas), descripcion: str(r.descripcion), habilitado: truthy(r.habilitado) };
  });
}
function readWeeks(form) {
  form = String(form || "").trim();
  var counts = countWeekRegistrations(form);
  return readTable(SHEETS.weeks).filter(function (r) { return r.id && rowMatchesForm(r, form); }).map(function (r) {
    var plazas = num(r.plazas), used = counts[String(r.id).trim()] || 0;
    var p1 = num(r.precio), p2 = num(r.precio_dto), p1r = num(r.precio_rdb), p2r = num(r.precio_rdb_dto);
    var w = {
      id: String(r.id).trim(), campus: str(r.campus), etiqueta: str(r.etiqueta), fechas: str(r.fechas),
      mostrar_plazas: str(r.mostrar_plazas),
      precio: str(r.precio),
      p1: p1,
      p2: p2 != null ? p2 : p1,
      p1_rdb: p1r != null ? p1r : p1,
      p2_rdb: p2r != null ? p2r : (p2 != null ? p2 : p1)
    };
    if (plazas != null) { w.plazas = plazas; w.plazas_restantes = Math.max(0, plazas - used); }
    return w;
  });
}
function readFields(form) {
  form = String(form || "").trim();
  return readTable(SHEETS.fields).filter(function (r) { return r.id && rowMatchesForm(r, form); }).map(function (r) {
    return {
      id: String(r.id).trim(), etiqueta: str(r.etiqueta), tipo: str(r.tipo) || "text",
      opciones: str(r.opciones), obligatorio: truthy(r.obligatorio), placeholder: str(r.placeholder),
      ayuda: str(r.ayuda), grupo: str(r.grupo) || "Inscripció", orden: num(r.orden) || 0
    };
  });
}

/* ---------- Fitxers → Drive ---------- */
function saveFiles(files, settings, payload, id) {
  if (!files || !files.length) return [];
  var folder = getUploadFolder(settings, payload);
  // Nom del nen/a per al nom del fitxer (si no n'hi ha, fem servir l'ID).
  var childName = (pickChild(payload) || id).replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || id;
  return files.map(function (f) {
    var bytes = Utilities.base64Decode(f.dataBase64);
    var ext = extensionFor(f.name, f.mimeType);
    var label = String(f.field || "document").replace(/[^\w\-]+/g, "_");
    // Ex.: "Marc_Puig - tarjeta_sanitaria.pdf"
    var fileName = childName + " - " + label + (ext ? "." + ext : "");
    var blob = Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", fileName);
    var file = folder.createFile(blob);
    return { field: f.field, name: file.getName(), url: file.getUrl() };
  });
}
// Carpeta destí: arrel/<carpeta_fitxers>/<hoja del formulari>.
// El nom de la subcarpeta és el mateix valor de la columna "hoja" de la pestanya
// Formularios (via subsSheetName), de manera que la carpeta de fitxers coincideix
// amb la pestanya on es guarden les inscripcions d'aquell formulari.
function getUploadFolder(settings, payload) {
  var root = getOrCreateFolder(DriveApp.getRootFolder(), settings.carpeta_fitxers || "Inscripcions - fitxers");
  var form = (payload && payload.form) || "";
  var sub = subsSheetName(form);
  // Fallbacks per si de cas (formulari sense hoja ni id).
  if (!sub) sub = (payload && payload.formName) || (payload && payload.campusName) || (payload && payload.campusId) || "General";
  sub = String(sub).replace(/[\/\\]+/g, "-").trim() || "General";
  return getOrCreateFolder(root, sub);
}
// Treu l'extensió del nom original; si no en té, la dedueix del mimeType.
function extensionFor(name, mime) {
  var m = String(name || "").match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) return m[1].toLowerCase();
  var map = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp" };
  return map[String(mime || "").toLowerCase()] || "";
}
function getOrCreateFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ---------- Guardar fila ----------
   Columnes: Timestamp · ID · [camps no-nota, amb Edat després de la data
   de naixement] · una columna 1/0 per setmana · Setmanes (text) */
function saveRow(id, payload, data) {
  var form = String(payload.form || "").trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = subsSheetName(form);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  var fields = readFields(form).filter(function (f) { return f.tipo !== "nota"; });
  var weeks = readWeeks(form);
  var labelById = {};
  fields.forEach(function (f) { labelById[f.id] = f.etiqueta || f.id; });

  // construeix l'ordre de columnes desitjat
  var plan = ["Timestamp", "ID", "Formulario"];
  fields.forEach(function (f) {
    plan.push(f.id);
    if (/naix/i.test(f.id) || f.tipo === "date") plan.push("Edat");
  });
  weeks.forEach(function (w) { plan.push(w.id); });
  plan.push("Setmanes");
  plan.push("Preu");
  plan.push("Descompte");
  plan.push("Estat");
  plan.push("Setmanes pagades");
  plan.push("Grups");

  // capçalera actual; afegeix les columnes que faltin (al final)
  var lastCol = sheet.getLastColumn();
  var header = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!header.length) {
    header = plan.slice();
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  } else {
    plan.forEach(function (col) {
      if (header.indexOf(col) === -1) { header.push(col); sheet.getRange(1, header.length, 1, 1).setValue(col); }
    });
  }

  var selected = {};
  (payload.weeks || []).forEach(function (w) { selected[w] = true; });
  var edat = computeAge(findBirthdate(data));

  var row = header.map(function (col) {
    if (col === "Timestamp") return new Date();
    if (col === "ID") return id;
    if (col === "Formulario") return payload.formName || form || "";
    if (col === "Edat") return edat != null ? edat : "";
    if (col === "Setmanes") return (payload.weekLabels || []).join(", ");
    if (col === "Preu") return payload.preu != null ? payload.preu : "";
    if (col === "Descompte") return payload.descompte || "";
    if (col === "Estat") return payload.estat || "Pendent";
    if (col === "Setmanes pagades") return payload.pagat_setmanes || "";
    if (col === "Grups") return payload.grups || "";
    if (selectedIsWeek(col, weeks)) return selected[col] ? 1 : 0;
    var fieldId = fieldIdForColumn(col, fields, labelById);
    if (fieldId && data[fieldId] != null) return data[fieldId];
    return data[col] != null ? data[col] : "";
  });
  sheet.appendRow(row);
}
function removeExistingSubmissionRows(form, shared) {
  if (!shared) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(subsSheetName(form));
  if (!sheet || sheet.getLastRow() < 2) return;

  var familyKey = buildFamilyKey(shared);
  if (!familyKey) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var toArchive = [];

  rows.forEach(function (row, idx) {
    if (buildFamilyKeyFromRow(row, header) === familyKey) toArchive.push({ rowIndex: idx + 2, data: row });
  });

  if (!toArchive.length) return;

  // Mou les files anteriors a la pestanya d'historial en lloc d'esborrar-les
  var histName = subsSheetName(form) + "_Historial";
  var histSheet = ss.getSheetByName(histName);
  if (!histSheet) {
    histSheet = ss.insertSheet(histName);
    histSheet.getRange(1, 1, 1, header.length + 1).setValues([header.concat(["Arxivada"])]);
    histSheet.setFrozenRows(1);
  }
  var now = new Date();
  toArchive.forEach(function (item) { histSheet.appendRow(item.data.concat([now])); });

  // Esborra de la pestanya principal (de baix a dalt per mantenir els índexs)
  for (var i = toArchive.length - 1; i >= 0; i--) sheet.deleteRow(toArchive[i].rowIndex);
}
function fieldIdForColumn(col, fields, labelById) {
  if (!col) return "";
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].id === col) return fields[i].id;
  }
  for (var id in labelById) {
    if (labelById[id] === col) return id;
  }
  return "";
}
function selectedIsWeek(col, weeks) {
  for (var i = 0; i < weeks.length; i++) if (weeks[i].id === col) return true;
  return false;
}
function buildFamilyKey(shared) {
  var nif = pickFirstValue(shared, [/^nif$/i, /document/i, /dni/i]);
  if (nif) return "nif:" + normalizeKeyPart(nif);

  var email = findEmail(shared);
  if (email) return "email:" + normalizeKeyPart(email);

  var tutor = pickFirstValue(shared, [/tutor/i, /pare/i, /mare/i, /padre/i, /madre/i]);
  var phone = pickFirstValue(shared, [/telefon/i, /telefono/i, /mobil/i, /movil/i, /phone/i]);
  if (tutor || phone) return "contacte:" + normalizeKeyPart(tutor) + "|" + normalizeKeyPart(phone);

  return "";
}
function buildFamilyKeyFromRow(row, header) {
  var data = {};
  header.forEach(function (col, idx) { data[String(col || "").trim()] = row[idx]; });

  var nif = pickFirstValue(data, [/^nif$/i, /document/i, /dni/i]);
  if (nif) return "nif:" + normalizeKeyPart(nif);

  var email = findEmail(data);
  if (email) return "email:" + normalizeKeyPart(email);

  var tutor = pickFirstValue(data, [/nom_tutor/i, /tutor/i, /pare/i, /mare/i, /padre/i, /madre/i]);
  var phone = pickFirstValue(data, [/telefon/i, /telefono/i, /mobil/i, /movil/i, /phone/i]);
  if (tutor || phone) return "contacte:" + normalizeKeyPart(tutor) + "|" + normalizeKeyPart(phone);

  return "";
}
function pickFirstValue(data, patterns) {
  if (!data) return "";
  for (var k in data) {
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(k) && str(data[k])) return str(data[k]);
    }
  }
  return "";
}
function normalizeKeyPart(v) {
  return str(v).toLowerCase().replace(/\s+/g, "");
}

/* ---------- Edat ---------- */
function findBirthdate(data) {
  for (var k in data) if (/naix|nacim|birth/i.test(k)) return data[k];
  return null;
}
function computeAge(v) {
  if (!v) return null;
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  var now = new Date();
  var age = now.getFullYear() - d.getFullYear();
  var m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return (age >= 0 && age < 120) ? age : null;
}

/* ---------- Places ---------- */
function countWeekRegistrations(form) {
  form = String(form || "").trim();
  var counts = {};
  var data = readSubmissionRows(form);          // cau per petició
  if (!data.rows.length) return counts;
  var weeks = readTable(SHEETS.weeks).filter(function (r) { return r.id && rowMatchesForm(r, form); }).map(function (r) { return String(r.id).trim(); });
  weeks.forEach(function (wid) {
    var c = 0;
    data.rows.forEach(function (row) { if (Number(row[wid]) === 1) c++; });
    counts[wid] = c;
  });
  return counts;
}

/* ---------- Correu ---------- */
function sendConfirmation(settings, payload, rows) {
  rows = rows || [];
  var to = findEmail((payload && payload.shared) || {}) || findEmail((payload && payload.data) || {});
  if (!to && payload && payload.children && payload.children.length) {
    for (var j = 0; j < payload.children.length && !to; j++) to = findEmail(payload.children[j].data || {});
  }
  for (var i = 0; i < rows.length && !to; i++) to = findEmail(rows[i].data || {});
  if (!to) return;

  var camp    = settings.nombre_campus || "Casal";
  var subject = settings.email_asunto  || ("✅ Inscripció confirmada · " + camp);
  var intro   = settings.email_intro   || "Hem rebut la inscripció correctament. Aquí tens el resum de tot el que ens has enviat:";
  var labels  = fieldLabels(payload.form);
  var multi   = rows.length > 1;
  var childGroupName = childGroupForForm(payload.form);
  var fieldGroup     = fieldGroups(payload.form);

  // Camps interns del frontend (no mostrar al correu)
  function isInternal(k) { return /^is_rdb$|^familia_nombrosa$/.test(k); }

  // ── Bloc compartit (dades del tutor/a) ──────────────────────────────────
  var sharedRows = "";
  if (payload.campusName) sharedRows += emailRow("Casal", payload.campusName);
  var first = (rows[0] && rows[0].data) || {};
  Object.keys(first).forEach(function (k) {
    if (fieldGroup[k] === childGroupName || isInternal(k)) return;
    if (first[k] === "" || first[k] == null) return;
    var v = String(first[k]).indexOf("http") === 0 ? "(fitxer adjuntat)" : first[k];
    sharedRows += emailRow(labels[k] || k, v);
  });
  var sharedBlock = sharedRows
    ? "<div style='margin:0 0 26px'>" +
        "<div class='em-section' style='font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#1F5AE0;font-weight:700;padding-bottom:8px;border-bottom:2px solid #EEF3FB;margin-bottom:12px'>Dades del tutor/a</div>" +
        "<table style='border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px'>" + sharedRows + "</table>" +
      "</div>"
    : "";

  // ── Blocs per jugador/a ──────────────────────────────────────────────────
  var childrenBlocks = rows.map(function (r, idx) {
    var d = r.data || {};
    var childEntry = (payload.children && payload.children[idx]) || {};

    // Nom del jugador/a (per a la capçalera del bloc)
    var childName = "";
    for (var k in d) {
      if (/nom/i.test(k) && !/tutor|pare|mare/i.test(k) && !childName) childName = str(d[k]);
    }

    // Camps del jugador/a
    var childRows = "";
    Object.keys(d).forEach(function (k) {
      if (fieldGroup[k] !== childGroupName || isInternal(k)) return;
      if (d[k] === "" || d[k] == null) return;
      var v = String(d[k]).indexOf("http") === 0 ? "(fitxer adjuntat)" : d[k];
      childRows += emailRow(labels[k] || k, v);
    });

    // Setmanes com a píndoles
    var weekPills = "";
    if (r.weekLabels && r.weekLabels.length) {
      weekPills = r.weekLabels.map(function (wl) {
        return "<span style='display:inline-block;background:#1F5AE0;color:#fff;border-radius:999px;" +
               "padding:4px 13px;font-size:12px;font-weight:700;margin:0 5px 5px 0;letter-spacing:.01em'>" +
               esc(wl) + "</span>";
      }).join("");
    }
    var weeksBlock = weekPills
      ? "<div class='em-divider' style='margin-top:14px;padding-top:13px;border-top:1px solid #EEF3FB'>" +
          "<div class='em-eyebrow' style='font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9DC0FF;font-weight:700;margin-bottom:8px'>Setmanes</div>" +
          "<div>" + weekPills + "</div>" +
        "</div>"
      : "";

    // Preu + descomptes
    var preuBlock = "";
    var preu = childEntry.preu;
    var descompte = childEntry.descompte && childEntry.descompte !== "-" ? childEntry.descompte : "";
    if (preu != null && preu > 0) {
      preuBlock =
        "<div class='em-soft' style='background:#EEF3FB;border-left:4px solid #1F5AE0;border-radius:9px;padding:14px 16px;margin-top:16px'>" +
          "<table style='border-collapse:collapse;width:100%'><tr>" +
            "<td class='em-price-label' style='font-weight:700;color:#0E2A63;font-size:14px;vertical-align:middle'>Preu</td>" +
            "<td class='em-price-val' style='text-align:right;font-size:22px;font-weight:800;color:#1F5AE0;vertical-align:middle'>" + preu +" €</td>" +
          "</tr>" +
          (descompte ? "<tr><td colspan='2' class='em-label' style='font-size:11px;color:#6B7C99;padding-top:5px'>Descomptes aplicats: " + esc(descompte) + "</td></tr>" : "") +
          "</table>" +
        "</div>";
    }

    // Fitxers
    var filesNote = (r.savedFiles && r.savedFiles.length)
      ? "<p class='em-muted' style='margin:12px 0 0;font-size:13px;color:#6B7C99'>📎 " + r.savedFiles.length + " document(s) rebut(s)</p>"
      : "";

    var blockTitle = multi
      ? ("Jugador/a " + (idx + 1) + (childName ? " · " + childName : ""))
      : (childName || "Jugador/a");

    return "<div class='em-cardborder' style='border:1.5px solid #D6DEEC;border-radius:11px;overflow:hidden;margin-bottom:14px'>" +
             "<div class='em-chip' style='background:#EEF3FB;background:linear-gradient(135deg,#EEF3FB 0%,#E2ECFB 100%);padding:13px 16px;border-bottom:1px solid #D6DEEC'>" +
               "<span class='em-chip-text' style='font-size:15px;font-weight:800;color:#0E2A63'>🏑 " + esc(blockTitle) + "</span>" +
             "</div>" +
             "<div style='padding:16px 16px 18px'>" +
               (childRows ? "<table style='border-collapse:collapse;width:100%;table-layout:fixed;font-size:14px'>" + childRows + "</table>" : "") +
               weeksBlock +
               preuBlock +
               filesNote +
             "</div>" +
           "</div>";
  }).join("");

  var badge = "✓ Rebuda correctament" + (multi ? " &nbsp;·&nbsp; " + rows.length + " jugadors/es" : "");

  // Estils de mode fosc: els clients mòbils (Gmail app, Apple Mail) enfosqueixen
  // els fons clars però sovint deixen el text fosc → text invisible. Declarem
  // color-scheme i sobreescrivim els colors inline amb classes + !important.
  var darkStyles =
    "<style>" +
      ":root{color-scheme:light dark;supported-color-schemes:light dark;}" +
      "@media (prefers-color-scheme:dark){" +
        ".em-body{background:#0b1220!important;color:#dfe7f5!important;}" +
        ".em-card{background:#111b30!important;border-color:#27344f!important;}" +
        ".em-cardborder{border-color:#27344f!important;}" +
        ".em-muted{color:#aab9d6!important;}" +
        ".em-label{color:#92a3c4!important;}" +
        ".em-val{color:#e8eefb!important;}" +
        ".em-chip{background:#1a2742!important;border-color:#27344f!important;}" +
        ".em-chip-text{color:#cfe0ff!important;}" +
        ".em-soft{background:#16223c!important;}" +
        ".em-price-label{color:#cfe0ff!important;}" +
        ".em-price-val{color:#7aa4ff!important;}" +
        ".em-divider{border-color:#27344f!important;}" +
        ".em-section{color:#7aa4ff!important;border-color:#27344f!important;}" +
        ".em-eyebrow{color:#9dc0ff!important;}" +
      "}" +
    "</style>";

  var html =
    "<!DOCTYPE html><html lang='ca'><head>" +
      "<meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<meta name='color-scheme' content='light dark'>" +
      "<meta name='supported-color-schemes' content='light dark'>" +
      darkStyles +
    "</head><body style='margin:0;padding:0'>" +

    "<div class='em-body' style='font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#f0f4fb;padding:20px 10px;color:#16233D'>" +

      // Capçalera
      "<div style='background:#0E2A63;background:linear-gradient(135deg,#0E2A63 0%,#16357C 55%,#1F5AE0 100%);border-radius:14px 14px 0 0;padding:30px 28px;border-top:4px solid #1F5AE0'>" +
        "<div style='font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:#9DC0FF;font-weight:700;margin-bottom:10px'>🏑 " + esc(camp) + "</div>" +
        "<div style='font-size:25px;font-weight:800;color:#fff;line-height:1.2;margin-bottom:18px'>Inscripció confirmada!&nbsp;🎉</div>" +
        "<span style='display:inline-block;background:rgba(255,255,255,.18);border-radius:999px;padding:5px 16px;font-size:13px;color:#fff;font-weight:700'>" + badge + "</span>" +
      "</div>" +

      // Cos
      "<div class='em-card' style='background:#fff;border:1px solid #D6DEEC;border-top:none;border-radius:0 0 14px 14px;padding:28px 28px 24px'>" +
        "<p class='em-muted' style='margin:0 0 24px;color:#4B5C7A;font-size:15px;line-height:1.65'>" + esc(intro) + "</p>" +
        sharedBlock +
        childrenBlocks +
      "</div>" +

    "</div>" +
    "</body></html>";

  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: camp, replyTo: settings.email_contacto || undefined });
}
// Mapa id_camp → grup, i nom del grup "per jugador/a" (mateixa detecció que el frontend).
function fieldGroups(form) {
  var m = {};
  readFields(form).forEach(function (f) { m[f.id] = f.grupo || "Inscripció"; });
  return m;
}
function childGroupForForm(form) {
  var names = [], seen = {};
  readFields(form).forEach(function (f) { var g = f.grupo || "Inscripció"; if (!seen[g]) { seen[g] = true; names.push(g); } });
  for (var i = 0; i < names.length; i++) if (/jugador|alumn|fill|nen|infant|nin/i.test(names[i])) return names[i];
  return names[0] || "";
}
function emailRow(k, v) {
  return "<tr>" +
    "<td class='em-label' style='width:40%;padding:7px 16px 7px 0;color:#6B7C99;vertical-align:top;font-size:14px;word-break:break-word'>" + esc(k) + "</td>" +
    "<td class='em-val' style='width:60%;padding:7px 0;font-weight:600;color:#16233D;font-size:14px;word-break:break-word'>" + esc(fmtDate(v)) + "</td>" +
  "</tr>";
}
// Converteix dates en format ISO (YYYY-MM-DD) a DD/MM/YYYY. Deixa la resta de valors intactes.
function fmtDate(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    var dd = ("0" + v.getDate()).slice(-2), mm = ("0" + (v.getMonth() + 1)).slice(-2);
    return dd + "/" + mm + "/" + v.getFullYear();
  }
  var s = String(v == null ? "" : v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  return m ? m[3] + "/" + m[2] + "/" + m[1] : v;
}
function fieldLabels(form) {
  var m = {};
  readFields(form).forEach(function (f) { m[f.id] = f.etiqueta || f.id; });
  return m;
}

/* ---------- Full ---------- */
function readTable(name) {
  if (_cache.tables[name]) return _cache.tables[name];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) { _cache.tables[name] = []; return _cache.tables[name]; }
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {}, empty = true;
    for (var c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      obj[header[c]] = values[i][c];
      if (values[i][c] !== "" && values[i][c] != null) empty = false;
    }
    if (!empty) out.push(obj);
  }
  _cache.tables[name] = out;
  return out;
}

/* ---------- Helpers ---------- */
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function str(v) { return v == null ? "" : String(v).trim(); }
function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
function truthy(v) { var s = String(v).trim().toLowerCase(); return s === "true" || s === "sí" || s === "si" || s === "x" || s === "1" || s === "yes"; }
function coerce(v) { if (typeof v !== "string") return v; var s = v.trim().toLowerCase(); if (s === "true") return true; if (s === "false") return false; return v; }
function findEmail(data) { if (data.email) return data.email; for (var k in data) if (/email|correu|correo/i.test(k) && /@/.test(String(data[k]))) return data[k]; return ""; }
function pickChild(payload) {
  var d = (payload && payload.data) || {};
  if ((!d || !Object.keys(d).length) && payload && payload.children && payload.children.length) d = payload.children[0].data || {};
  for (var k in d) if (/nom/i.test(k) && !/tutor|pare|mare/i.test(k)) return d[k];
  return "";
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

/* ============================================================
   PANELL D'ADMINISTRACIÓ (admin.html)
   --------------------------------------------------------------
   Totes les peticions arriben per POST amb { action, pin, ... } i
   es validen contra el PIN desat a Ajustes (clau "admin_pin").
   Sense admin_pin configurat, el panell queda bloquejat.
   ============================================================ */

// Comprova el PIN d'administració i gestiona el bloqueig per intents fallits.
function adminAuth(pin) {
  if (isAdminLocked()) return { ok: false, locked: true };
  var s = readSettings("");
  var real = str(s.admin_pin);
  if (!real) return { ok: false, error: "no_pin" };
  if (str(pin) === real) { clearAdminFailures(); return { ok: true }; }
  recordAdminFailure();
  return { ok: false, locked: isAdminLocked() };
}

// Llista de formularis per al selector del panell (sempre amb el per defecte).
function adminForms() {
  var g = readSettings("");
  var def = str(g.form_defecto);
  var forms = readForms().map(function (f) { return { id: f.id, nombre: f.nombre || f.id, estacio: f.estacio, habilitado: f.habilitado }; });
  if (!forms.length) forms = [{ id: def, nombre: str(g.nombre_campus) || "Formulari", estacio: "", habilitado: true }];
  else if (def && !forms.some(function (f) { return f.id === def; })) {
    forms.unshift({ id: def, nombre: str(g.nombre_campus) || def, estacio: "", habilitado: true });
  }
  return forms;
}

// Router de les accions d'administració.
function handleAdmin(p) {
  try {
    // Login: autentica amb PIN i retorna un token de sessió UUID.
    if (p.action === "admin_login") {
      var auth = adminAuth(p.pin);
      if (!auth.ok) return { ok: false, error: auth.locked ? "locked" : "unauthorized" };
      var tok = createAdminToken();
      var cfg = readSettings("");
      return { ok: true, token: tok, forms: adminForms(), settings: { nombre_campus: str(cfg.nombre_campus), club: str(cfg.club), SCRIPT_URL: str(cfg.SCRIPT_URL) } };
    }
    // Logout: invalida el token immediatament.
    if (p.action === "admin_logout") { revokeAdminToken(p.token); return { ok: true }; }

    // Totes les altres accions requereixen un token vàlid (no el PIN).
    if (!validateAdminToken(p.token)) return { ok: false, error: "unauthorized" };

    var form = str(p.form);
    if (!form) { var g = readSettings(""); form = str(g.form_defecto); }
    switch (p.action) {
      case "admin_session": {    // restaura la sessió sense enviar el PIN de nou
        var sc = readSettings("");
        return { ok: true, forms: adminForms(), settings: { nombre_campus: str(sc.nombre_campus), club: str(sc.club) } };
      }
      case "admin_data": {       // overview + llista en una sola petició (cau compartida)
        var ov = adminOverview(form);
        var ls = adminList(form);
        return { ok: true, overview: ov, list: ls.rows };
      }
      case "admin_overview":    return adminOverview(form);
      case "admin_list":        return adminList(form);
      case "admin_set_status":  return adminSetStatus(form, p.id, p.estat);
      case "admin_set_payment": return adminSetPayment(form, p.id, p.weeks);
      case "admin_set_group":   return adminSetGroup(form, p.id, p.week, p.color);
      case "admin_set_groups_config": return adminSetGroupsConfig(p.config);
      case "admin_resend":      return adminResend(form, p.id);
      case "admin_reminder":    return adminReminder(form, p.ids || (p.id ? [p.id] : []));
      case "admin_update":      return adminUpdate(form, p.id, p.patch);
      case "admin_cancel":      return adminCancel(form, p.id);
      default:                 return { ok: false, error: "unknown action" };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Llegeix totes les files d'inscripció d'un formulari com a objectes {capçalera: valor}.
// Cau per petició: es llegeix el full una sola vegada encara que es cridi diversos cops.
function readSubmissionRows(form) {
  var key = String(form || "");
  if (_cache.subs[key]) return _cache.subs[key];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(subsSheetName(form));
  if (!sheet || sheet.getLastRow() < 2) { _cache.subs[key] = { header: [], rows: [], sheet: sheet }; return _cache.subs[key]; }
  var lastCol = sheet.getLastColumn(), lastRow = sheet.getLastRow();
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var rows = values.map(function (r, i) {
    var o = {};
    header.forEach(function (h, c) { if (h) o[h] = r[c]; });
    o.__row = i + 2;
    return o;
  });
  _cache.subs[key] = { header: header, rows: rows, sheet: sheet };
  return _cache.subs[key];
}

// Setmanes per a les quals s'ha registrat el jugador/a (columnes 1/0).
function rowRegisteredWeeks(row, weekIds) {
  return weekIds.filter(function (id) { return Number(row[id]) === 1; });
}
// Setmanes ja pagades (de la columna "Setmanes pagades"), netes de duplicats.
function rowPaidWeeks(row, registered) {
  var raw = str(row["Setmanes pagades"]);
  if (!raw) return [];
  var paid = raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return paid.filter(function (w) { return registered.indexOf(w) !== -1; });
}
// Estat derivat de quantes setmanes registrades estan pagades.
function computeEstat(paid, registered) {
  if (!registered || !registered.length) return "Pendent";
  if (!paid || !paid.length) return "Pendent";
  return paid.length >= registered.length ? "Pagat" : "Parcial";
}

/* ---------- Grups per edat (vestidors) ---------- */
function defaultGroups() {
  return [
    { color: "blau",    label: "Blau",    min: 4,  max: 6 },
    { color: "vermell", label: "Vermell", min: 7,  max: 9 },
    { color: "taronja", label: "Taronja", min: 10, max: 11 },
    { color: "verd",    label: "Verd",    min: 12, max: 14 }
  ];
}
// Llegeix la config de grups de l'Ajustes (clau "grups_edats"):
//   "blau:4-6; verd:7-8; taronja:9-10; vermell:11-99"
function groupsConfig(settings) {
  var raw = str(settings && settings.grups_edats);
  if (!raw) return defaultGroups();
  var labels = { blau: "Blau", verd: "Verd", taronja: "Taronja", vermell: "Vermell" };
  var out = [];
  raw.split(/[;,]/).forEach(function (part) {
    var kv = part.split(":");
    if (kv.length < 2) return;
    var color = str(kv[0]).toLowerCase();
    var range = str(kv[1]).split("-");
    var min = num(range[0]), max = num(range[1]);
    if (color && min != null) out.push({ color: color, label: labels[color] || color, min: min, max: (max != null ? max : 99) });
  });
  return out.length ? out : defaultGroups();
}
function autoGroupColor(age, groups) {
  if (age == null || isNaN(age)) return groups.length ? groups[0].color : "";
  for (var i = 0; i < groups.length; i++) if (age >= groups[i].min && age <= groups[i].max) return groups[i].color;
  var sorted = groups.slice().sort(function (a, b) { return a.min - b.min; });
  return age < sorted[0].min ? sorted[0].color : sorted[sorted.length - 1].color;
}
function parseGroupOverrides(s) {
  var map = {};
  String(s || "").split(/[;,]/).forEach(function (p) {
    var kv = p.split(":");
    if (kv.length < 2) return;
    var w = String(kv[0]).trim(), c = String(kv[1]).trim().toLowerCase();
    if (w && c) map[w] = c;
  });
  return map;
}
function serializeGroupOverrides(map) {
  return Object.keys(map).map(function (w) { return w + ":" + map[w]; }).join("; ");
}
function adminRowEstat(row) { return str(row.Estat) || "Pendent"; }
function adminRowName(row, form) {
  var v = pickFirstValue(row, [/^nom_jugador$/i]);
  if (v) return v;
  for (var k in row) { if (/nom/i.test(k) && !/tutor|pare|mare|formulari|formulario/i.test(k) && str(row[k])) return str(row[k]); }
  return "";
}
function adminBaseId(id) { return String(id || "").replace(/-\d+$/, ""); }
function adminToISODate(v) {
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
}
function adminFileUrls(row) {
  var urls = [];
  for (var k in row) {
    if (k === "__row") continue;
    var val = String(row[k] == null ? "" : row[k]);
    if (val.indexOf("http") === 0) {
      val.split(/[\s\n]+/).forEach(function (u) { if (u.indexOf("http") === 0) urls.push(u); });
    }
  }
  return urls;
}

// Estadístiques agregades per a les targetes i els gràfics.
function adminOverview(form) {
  var data = readSubmissionRows(form);
  var rows = data.rows;
  var weeksCfg = readWeeks(form);

  var weekIds = weeksCfg.map(function (w) { return w.id; });
  var ingressosTotal = 0, ingressosCobrats = 0, preuComptats = 0;
  var families = {}, enviaments = {};
  var perDay = {}, ages = {}, payments = { Pagat: 0, Parcial: 0, Pendent: 0 };
  var discounts = { rdb: 0, fn: 0, germa: 0, cap: 0 };

  rows.forEach(function (row) {
    var preu = num(row.Preu) || 0;
    ingressosTotal += preu;
    if (preu > 0) preuComptats++;
    // Pagament per setmanes: estat derivat i ingressos cobrats proporcionals.
    var registered = rowRegisteredWeeks(row, weekIds);
    var paid = rowPaidWeeks(row, registered);
    var estat = computeEstat(paid, registered);
    if (estat === "Pagat") payments.Pagat++;
    else if (estat === "Parcial") payments.Parcial++;
    else payments.Pendent++;
    if (registered.length) ingressosCobrats += preu * (paid.length / registered.length);

    var fk = buildFamilyKey(row); if (fk) families[fk] = true;
    enviaments[adminBaseId(row.ID)] = true;

    var day = adminToISODate(row.Timestamp);
    if (day) perDay[day] = (perDay[day] || 0) + 1;

    var edat = num(row.Edat);
    if (edat != null && edat >= 0 && edat < 30) ages[edat] = (ages[edat] || 0) + 1;

    var desc = str(row.Descompte);
    var any = false;
    if (/riudebitlles|rdb/i.test(desc)) { discounts.rdb++; any = true; }
    if (/nombrosa/i.test(desc)) { discounts.fn++; any = true; }
    if (/germ/i.test(desc)) { discounts.germa++; any = true; }
    if (!any) discounts.cap++;
  });

  var weeks = weeksCfg.map(function (w) {
    var inscrits = 0;
    rows.forEach(function (r) { if (Number(r[w.id]) === 1) inscrits++; });
    return {
      id: w.id, etiqueta: w.etiqueta, fechas: w.fechas,
      plazas: (w.plazas != null ? w.plazas : null), inscrits: inscrits
    };
  });

  var perDayArr = Object.keys(perDay).sort().map(function (d) { return { date: d, count: perDay[d] }; });
  var maxAge = 0; Object.keys(ages).forEach(function (a) { if (Number(a) > maxAge) maxAge = Number(a); });
  var agesArr = [];
  for (var a = 0; a <= maxAge; a++) if (ages[a]) agesArr.push({ age: a, count: ages[a] });

  var recent = rows.slice(-8).reverse().map(function (r) {
    return { id: str(r.ID), nom: adminRowName(r, form), data: adminToISODate(r.Timestamp), preu: num(r.Preu) || 0, estat: adminRowEstat(r) };
  });

  return {
    ok: true,
    form: form,
    generatedAt: new Date().toISOString(),
    kpis: {
      jugadors: rows.length,
      enviaments: Object.keys(enviaments).length,
      families: Object.keys(families).length,
      ingressos_total: Math.round(ingressosTotal),
      ingressos_cobrats: Math.round(ingressosCobrats),
      ingressos_pendents: Math.round(ingressosTotal - ingressosCobrats),
      preu_mitja: preuComptats ? Math.round(ingressosTotal / preuComptats) : 0
    },
    weeks: weeks,
    perDay: perDayArr,
    ages: agesArr,
    discounts: discounts,
    payments: payments,
    groups: groupsConfig(readSettings(form)),
    recent: recent
  };
}

// Llista completa per a la taula + detall.
function adminList(form) {
  var data = readSubmissionRows(form);
  var fields = readFields(form).filter(function (f) { return f.tipo !== "nota"; });
  var labels = fieldLabels(form);
  var childGroup = childGroupForForm(form);
  var groups = fieldGroups(form);
  var weekIds = readWeeks(form).map(function (w) { return w.id; });

  var rows = data.rows.map(function (row) {
    var detail = [];
    fields.forEach(function (f) {
      var v = row[f.id];
      if (v == null || v === "") return;
      detail.push({ label: labels[f.id] || f.id, value: String(v), grup: groups[f.id] || "", esJugador: groups[f.id] === childGroup });
    });
    var registered = rowRegisteredWeeks(row, weekIds);
    var paid = rowPaidWeeks(row, registered);
    return {
      id: str(row.ID),
      baseId: adminBaseId(row.ID),
      row: row.__row,
      ts: adminToISODate(row.Timestamp),
      formulario: str(row.Formulario),
      nom: adminRowName(row, form),
      tutor: pickFirstValue(row, [/nom_tutor/i, /tutor/i]),
      email: findEmail(row),
      telefon: pickFirstValue(row, [/telefon|telefono|mobil|movil/i]),
      edat: (num(row.Edat) != null ? num(row.Edat) : ""),
      setmanes: str(row.Setmanes),
      weekIds: registered,
      paidWeeks: paid,
      preu: num(row.Preu) || 0,
      descompte: str(row.Descompte),
      estat: computeEstat(paid, registered),
      grups: parseGroupOverrides(str(row.Grups)),
      sapNedar: pickFirstValue(row, [/sap_nedar/i, /nedar|nadar|swim/i]),
      fitxers: adminFileUrls(row),
      detall: detail
    };
  }).reverse();

  return { ok: true, form: form, rows: rows };
}

// Garanteix que existeix una columna; retorna el seu índex (1-based).
function ensureColumn(sheet, header, name) {
  var col = header.indexOf(name) + 1;
  if (col === 0) {
    col = header.length + 1;
    sheet.getRange(1, col, 1, 1).setValue(name);
    header.push(name);
  }
  return col;
}

// Defineix quines setmanes estan pagades d'una fila i recalcula l'estat
// (Pagat / Parcial / Pendent). És l'operació base del pagament per setmanes.
function adminSetPayment(form, id, weeks) {
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var weekIds = readWeeks(form).map(function (w) { return w.id; });
  var target = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) target = r; });
  if (!target) return { ok: false, error: "row not found" };

  var registered = rowRegisteredWeeks(target, weekIds);
  // Només acceptem setmanes en què realment està inscrit.
  var paid = (weeks || []).map(String).filter(function (w) { return registered.indexOf(w) !== -1; });
  var estat = computeEstat(paid, registered);

  var paidCol = ensureColumn(sheet, data.header, "Setmanes pagades");
  var estatCol = ensureColumn(sheet, data.header, "Estat");
  sheet.getRange(target.__row, paidCol, 1, 1).setValue(paid.join(", "));
  sheet.getRange(target.__row, estatCol, 1, 1).setValue(estat);
  return { ok: true, id: id, estat: estat, paidWeeks: paid };
}

// Compat: marcar com a Pagat = totes les setmanes; Pendent = cap.
function adminSetStatus(form, id, estat) {
  var data = readSubmissionRows(form);
  var weekIds = readWeeks(form).map(function (w) { return w.id; });
  var target = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) target = r; });
  if (!target) return { ok: false, error: "row not found" };
  var registered = rowRegisteredWeeks(target, weekIds);
  return adminSetPayment(form, id, (str(estat) === "Pagat") ? registered : []);
}

// Mou un jugador/a a un color de grup per a una setmana concreta.
// Si el color coincideix amb l'automàtic (per edat), s'esborra l'excepció.
function adminSetGroup(form, id, week, color) {
  week = str(week); color = str(color).toLowerCase();
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var target = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) target = r; });
  if (!target) return { ok: false, error: "row not found" };

  var groups = groupsConfig(readSettings(form));
  var auto = autoGroupColor(num(target.Edat), groups);
  var map = parseGroupOverrides(str(target.Grups));
  if (!week) return { ok: false, error: "week missing" };
  if (!color || color === auto) delete map[week]; else map[week] = color;

  var col = ensureColumn(sheet, data.header, "Grups");
  sheet.getRange(target.__row, col, 1, 1).setValue(serializeGroupOverrides(map));
  return { ok: true, id: id, grups: map };
}

// Desa els intervals d'edat dels grups a Ajustes (global, per a tots els formularis).
function adminSetGroupsConfig(config) {
  if (!config || !config.length) return { ok: false, error: "config buida" };
  var parts = config.map(function (g) {
    return String(g.color).toLowerCase() + ":" + num(g.min) + "-" + num(g.max);
  });
  writeSetting("grups_edats", parts.join("; "));
  return { ok: true, groups: groupsConfig(readSettings("")) };
}

// Escriu (o crea) una fila Clave/Valor global a la pestanya Ajustes.
function writeSetting(key, value) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.settings);
  if (!sheet) { sheet = ss.insertSheet(SHEETS.settings); sheet.getRange(1, 1, 1, 2).setValues([["Clave", "Valor"]]); }
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim(); });
  var kc = header.indexOf("Clave"); if (kc < 0) kc = header.indexOf("clave"); if (kc < 0) kc = 0;
  var vc = header.indexOf("Valor"); if (vc < 0) vc = header.indexOf("valor"); if (vc < 0) vc = 1;
  var formCol = header.indexOf("form");
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][kc]).trim() === key) {
      var rf = formCol >= 0 ? String(values[i][formCol]).trim() : "";
      if (!rf) { sheet.getRange(i + 1, vc + 1, 1, 1).setValue(value); return; }
    }
  }
  var row = []; for (var j = 0; j < header.length; j++) row.push("");
  row[kc] = key; row[vc] = value;
  sheet.appendRow(row);
}

// Reenvia el correu de confirmació d'una fila concreta.
function adminResend(form, id) {
  var settings = readSettings(form);
  var data = readSubmissionRows(form);
  var match = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) match = r; });
  if (!match) return { ok: false, error: "row not found" };

  var childGroup = childGroupForForm(form);
  var groups = fieldGroups(form);
  var shared = {}, cd = {};
  readFields(form).forEach(function (f) {
    if (f.tipo === "nota") return;
    var v = match[f.id];
    if (v == null || v === "") return;
    if (groups[f.id] === childGroup) cd[f.id] = v; else shared[f.id] = v;
  });
  if (!shared.email) shared.email = findEmail(match);

  var weekLabels = str(match.Setmanes).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  var files = adminFileUrls(match).map(function (u) { return { url: u, name: "document" }; });
  var merged = {}; Object.keys(shared).forEach(function (k) { merged[k] = shared[k]; }); Object.keys(cd).forEach(function (k) { merged[k] = cd[k]; });

  var payload = {
    form: form, formName: str(match.Formulario) || form, campusName: "",
    shared: shared,
    children: [{ data: cd, weekLabels: weekLabels, preu: num(match.Preu), descompte: str(match.Descompte) }]
  };
  var rows = [{ id: id, data: merged, weekLabels: weekLabels, savedFiles: files }];
  sendConfirmation(settings, payload, rows);
  return { ok: true, id: id, to: shared.email };
}

/* ---------- Recordatori de pagament ----------
   Envia un correu de recordatori a una o més inscripcions amb pagament
   pendent o parcial. Les ja pagades s'ignoren (no hi ha res a recordar). */
function adminReminder(form, ids) {
  var settings = readSettings(form);
  var data = readSubmissionRows(form);
  var weekIds = readWeeks(form).map(function (w) { return w.id; });
  var list = (ids || []).map(String);
  var sent = 0, lastTo = "";
  list.forEach(function (id) {
    var match = null;
    data.rows.forEach(function (r) { if (str(r.ID) === str(id)) match = r; });
    if (!match) return;
    var to = findEmail(match);
    if (!to) return;
    var registered = rowRegisteredWeeks(match, weekIds);
    var paid = rowPaidWeeks(match, registered);
    if (computeEstat(paid, registered) === "Pagat") return;   // res a recordar
    sendReminder(settings, form, match, registered, paid);
    sent++; lastTo = to;
  });
  return { ok: true, sent: sent, to: (list.length === 1 ? lastTo : undefined) };
}

function sendReminder(settings, form, row, registered, paid) {
  var to = findEmail(row);
  if (!to) return;
  var camp = settings.nombre_campus || "Casal";
  var name = adminRowName(row, form) || "la inscripció";
  var preu = num(row.Preu) || 0;
  var pendentSetmanes = registered.filter(function (w) { return paid.indexOf(w) === -1; });
  var pendentImport = registered.length ? Math.round(preu * (pendentSetmanes.length / registered.length)) : 0;

  var labelById = {};
  readWeeks(form).forEach(function (w) { labelById[w.id] = w.etiqueta || w.id; });
  var pills = pendentSetmanes.map(function (w) {
    return "<span style='display:inline-block;background:#D97706;color:#fff;border-radius:999px;padding:4px 13px;font-size:12px;font-weight:700;margin:0 5px 5px 0'>" + esc(labelById[w] || w) + "</span>";
  }).join("");

  var subject = settings.email_recordatori_asunto || ("Recordatori de pagament · " + camp);
  var intro = settings.email_recordatori_intro ||
    ("Et recordem que la inscripció de " + name + " encara té un pagament pendent. Si ja l'has fet, pots ignorar aquest missatge.");
  var contacte = settings.email_contacto || "";

  var html =
    "<!DOCTYPE html><html lang='ca'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
    "<body style='margin:0;padding:0'>" +
    "<div style='font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#f0f4fb;padding:20px 10px;color:#16233D'>" +
      "<div style='background:linear-gradient(135deg,#0E2A63 0%,#16357C 55%,#1F5AE0 100%);border-radius:14px 14px 0 0;padding:28px;border-top:4px solid #D97706'>" +
        "<div style='font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:#FCD9A6;font-weight:700;margin-bottom:10px'>🏑 " + esc(camp) + "</div>" +
        "<div style='font-size:23px;font-weight:800;color:#fff;line-height:1.2'>Recordatori de pagament</div>" +
      "</div>" +
      "<div style='background:#fff;border:1px solid #D6DEEC;border-top:none;border-radius:0 0 14px 14px;padding:26px 28px'>" +
        "<p style='margin:0 0 20px;color:#4B5C7A;font-size:15px;line-height:1.65'>" + esc(intro) + "</p>" +
        (pendentImport > 0
          ? "<div style='background:#FEF3C7;border-left:4px solid #D97706;border-radius:9px;padding:14px 16px;margin-bottom:18px'>" +
              "<table style='border-collapse:collapse;width:100%'><tr>" +
                "<td style='font-weight:700;color:#0E2A63;font-size:14px'>Pendent de pagar</td>" +
                "<td style='text-align:right;font-size:22px;font-weight:800;color:#B45309'>" + pendentImport + " €</td>" +
              "</tr></table></div>"
          : "") +
        (pills ? "<div style='font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9DC0FF;font-weight:700;margin-bottom:8px'>Setmanes pendents</div><div style='margin-bottom:18px'>" + pills + "</div>" : "") +
        (contacte ? "<p style='margin:0;color:#6B7C99;font-size:13px'>Per a qualsevol dubte, escriu-nos a <a href='mailto:" + esc(contacte) + "' style='color:#1F5AE0'>" + esc(contacte) + "</a>.</p>" : "") +
      "</div>" +
    "</div></body></html>";

  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: camp, replyTo: contacte || undefined });
}

/* ---------- Edició de dades de contacte ----------
   Actualitza el correu i/o el telèfon d'una inscripció (corregir typos).
   Escriu sobre la columna que ja conté aquell tipus de dada. */
function adminUpdate(form, id, patch) {
  patch = patch || {};
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var target = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) target = r; });
  if (!target) return { ok: false, error: "row not found" };
  var header = data.header;
  var updated = {};

  function writeFirst(re, value) {
    for (var c = 0; c < header.length; c++) {
      if (header[c] && re.test(header[c])) {
        sheet.getRange(target.__row, c + 1, 1, 1).setValue(value);
        return true;
      }
    }
    return false;
  }

  if (patch.email != null && writeFirst(/email|correu|correo/i, patch.email)) updated.email = patch.email;
  if (patch.telefon != null && writeFirst(/telefon|telefono|mobil|movil|phone/i, patch.telefon)) updated.telefon = patch.telefon;
  return { ok: true, id: id, updated: updated };
}

/* ---------- Anul·lació d'inscripció ----------
   Mou la fila a la pestanya d'historial i l'esborra de la principal
   (mateix patró que removeExistingSubmissionRows). */
function adminCancel(form, id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var target = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) target = r; });
  if (!target) return { ok: false, error: "row not found" };

  var header = data.header;
  var rowValues = sheet.getRange(target.__row, 1, 1, header.length).getValues()[0];
  var histName = subsSheetName(form) + "_Historial";
  var hist = ss.getSheetByName(histName);
  if (!hist) {
    hist = ss.insertSheet(histName);
    hist.getRange(1, 1, 1, header.length + 1).setValues([header.concat(["Arxivada"])]);
    hist.setFrozenRows(1);
  }
  hist.appendRow(rowValues.concat([new Date()]));
  sheet.deleteRow(target.__row);
  return { ok: true, id: id };
}
