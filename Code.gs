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
var SUB_RATE_LIMIT  = 60;    // màx. enviaments per minut (global). És un fre antiabús; el posem
                             // prou alt perquè una obertura d'inscripcions amb molta gent alhora
                             // no doni un fals "Massa sol·licituds" a famílies legítimes.
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
  // Staging de fitxers: el formulari puja les fotos en segon pla mentre s'omple,
  // i les esborra si no s'acaba enviant. Es processen abans del lock d'inscripció.
  if (pre && pre.action === "upload") return json(handleStagedUpload(pre));
  if (pre && pre.action === "delete") return json(handleStagedDelete(pre));
  if (pre && pre.action) return json(handleAdmin(pre));

  if (!checkSubmissionRateLimit()) return json({ ok: false, error: "Massa sol·licituds. Espera un moment i torna-ho a provar." });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var payload = JSON.parse(e.postData.contents);
    var form = String(payload.form || "").trim();
    if (!form) form = defaultFormId();
    payload.form = form;

    // Anti-duplicats: un doble clic o un reintent de xarxa envien la mateixa inscripció
    // dues vegades. Com que el lock serialitza les peticions, la primera la processa i en
    // desa la resposta a la memòria cau; la segona (mateixa signatura) la retorna tal qual,
    // sense reprocessar ni reenviar cap correu. Una correcció real té dades diferents →
    // signatura diferent → no es bloqueja.
    var sig = submissionSignature(payload);
    var dupCache = CacheService.getScriptCache();
    if (sig) { var prev = dupCache.get("dup_" + sig); if (prev) return json(JSON.parse(prev)); }

    var baseId = "INS-" + new Date().getTime();
    var settings = readSettings(form);

    // Normalitza: sempre treballem amb una llista de jugadors/es ("entries").
    // Format nou  → { shared:{...}, children:[ {data, weeks, weekLabels, files}, ... ] }
    // Format antic → { data:{...}, weeks:[...], weekLabels:[...], files:[...] }  (un sol jugador/a)
    var shared = payload.shared || {};
    var entries = (payload.children && payload.children.length)
      ? payload.children
      : [{ data: payload.data || {}, weeks: payload.weeks || [], weekLabels: payload.weekLabels || [], files: payload.files || [] }];

    removeExistingSubmissionRows(form, shared);

    // Signatura de qui fa la inscripció: es desa un sol cop a Drive i el mateix enllaç
    // s'escriu a la columna "Signatura" de cada fila (germans inclosos).
    var signatureUrl = "";
    try { signatureUrl = saveSignature(payload.signature, settings, { form: form, formName: payload.formName }, baseId); }
    catch (sigErr) { signatureUrl = ""; }

    // Tot SÍNCRON, sense triggers. Els triggers de l'Apps Script NO són immediats (un ".after"
    // pot trigar 1-3 minuts a disparar-se): per això el correu arribava tard. Aquí desem la fila,
    // movem els fitxers i enviem el correu dins la mateixa petició → el correu arriba a l'instant.
    // Les fotos ja s'han pujat en segon pla mentre s'omplia el formulari (staging), així que aquí
    // només cal moure-les a la carpeta final (ràpid). Quan no s'adjunta res, no es toca Drive.
    var rows = [];
    entries.forEach(function (child, idx) {
      var id = baseId + (entries.length > 1 ? "-" + (idx + 1) : "");
      var cd = child.data || {};
      var filePayload = { data: cd, formName: payload.formName, form: form };

      // Mou els fitxers (staging) + desa els inline (base64). saveFiles gestiona els dos casos.
      // La reutilització de fitxers d'altres campus NO es fa aquí: escaneja altres fulls (lent) i
      // justament es dispararia quan NO s'adjunta res. Es fa en segon pla (reuseMissingFilesJob,
      // activador horari), així l'enviament és igual de ràpid s'adjunti o no la targeta.
      var saved = saveFiles(child.files || [], settings, filePayload, id);
      var allFiles = saved;

      var byField = {};
      allFiles.forEach(function (s) { (byField[s.field] = byField[s.field] || []).push(s.url); });

      var data = {};
      Object.keys(shared).forEach(function (k) { data[k] = shared[k]; });
      Object.keys(cd).forEach(function (k) { data[k] = cd[k]; });
      Object.keys(byField).forEach(function (k) { data[k] = byField[k].join("\n"); });
      if (!data.email) data.email = findEmail(shared) || findEmail(cd) || findEmail(payload.data || {}) || "";

      var rowPayload = {
        form: form, formName: payload.formName, campusId: payload.campusId, campusName: payload.campusName,
        weeks: child.weeks || [], weekLabels: child.weekLabels || [],
        preu: child.preu != null ? child.preu : null,
        descompte: child.descompte || "",
        signatura: signatureUrl
      };
      saveRow(id, rowPayload, data);
      rows.push({ id: id, data: data, weekLabels: child.weekLabels || [], savedFiles: allFiles });
    });

    // Correu de confirmació SÍNCRON → arriba a l'instant. Si falla l'enviament, la inscripció ja
    // s'ha desat igualment, així que responem ok (no fem caure tot el procés per un error de correu).
    try {
      sendConfirmation(settings, {
        form: form, formName: payload.formName, campusName: payload.campusName,
        shared: shared, children: payload.children || []
      }, rows);
    } catch (mailErr) {}

    var resp = { ok: true, id: baseId, count: entries.length };
    if (sig) dupCache.put("dup_" + sig, JSON.stringify(resp), 30);
    return json(resp);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Signatura estable d'una inscripció (form + dades compartides + dades i setmanes de cada
// fill), SENSE el timestamp, per detectar enviaments duplicats (doble clic / reintent de xarxa).
function submissionSignature(payload) {
  try {
    var parts = ["f=" + String((payload && payload.form) || "")];
    var sh = (payload && payload.shared) || {};
    Object.keys(sh).sort().forEach(function (k) { parts.push(k + "=" + str(sh[k])); });
    var kids = (payload && payload.children && payload.children.length)
      ? payload.children
      : [{ data: (payload && payload.data) || {}, weeks: (payload && payload.weeks) || [] }];
    kids.forEach(function (c) {
      var d = c.data || {};
      Object.keys(d).sort().forEach(function (k) { parts.push(k + "=" + str(d[k])); });
      parts.push("w=" + (c.weeks || []).join(","));
    });
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, parts.join("|"), Utilities.Charset.UTF_8);
    return digest.map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
  } catch (e) { return ""; }
}

/* ---------- Config ---------- */
// Formulari per defecte quan no se n'indica cap (obrir index.html sense ?form=):
// el primer de la pestanya "Formularios" amb "habilitado" = TRUE. Si no n'hi ha
// cap d'habilitat, el primer de la llista (mostrarà "inscripcions tancades").
function defaultFormId() {
  var forms = readForms();
  for (var i = 0; i < forms.length; i++) { if (forms[i].habilitado !== false) return forms[i].id; }
  return forms.length ? forms[0].id : "";
}

function buildConfig(form) {
  form = String(form || "").trim();
  if (!form) form = defaultFormId();
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
    // "dashboard_activo" controla si el formulari es mostra al panell d'administració,
    // independentment de "habilitado" (que controla el formulari públic). Si la columna no
    // existeix o és buida, per compatibilitat caiem a "habilitado".
    var dashRaw = r.dashboard_activo;
    var dash = (dashRaw == null || String(dashRaw).trim() === "") ? hab : truthy(dashRaw);
    return { id: id, nombre: str(r.nombre), habilitado: hab, dashboardActiu: dash, hoja: str(r.hoja), estacio: str(r.estacio) };
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
// Versió lleugera: només id + etiqueta de cada setmana, SENSE comptar places (no
// llegeix el full d'inscripcions). Per a quan només cal planificar columnes (saveRow).
function readWeekDefs(form) {
  form = String(form || "").trim();
  return readTable(SHEETS.weeks).filter(function (r) { return r.id && rowMatchesForm(r, form); }).map(function (r) {
    return { id: String(r.id).trim(), etiqueta: str(r.etiqueta) };
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
    var ext = extensionFor(f.name, f.mimeType);
    var label = String(f.field || "document").replace(/[^\w\-]+/g, "_");
    // Ex.: "Marc_Puig - tarjeta_sanitaria.pdf"
    var fileName = childName + " - " + label + (ext ? "." + ext : "");
    var file = null;
    if (f.ref) {
      // Ja pujat en segon pla (staging): el reanomenem i el movem a la carpeta definitiva.
      try { file = DriveApp.getFileById(f.ref); file.setName(fileName); file.moveTo(folder); }
      catch (e) { file = null; }
    }
    if (!file && f.dataBase64) {
      // Fallback: arribava inline en base64.
      var blob = Utilities.newBlob(Utilities.base64Decode(f.dataBase64), f.mimeType || "application/octet-stream", fileName);
      file = folder.createFile(blob);
    }
    if (!file) return null;
    return { field: f.field, name: file.getName(), url: file.getUrl() };
  }).filter(function (x) { return x; });
}

// Desa la signatura (PNG dibuixat pel tutor/a) a la carpeta de fitxers del formulari i
// en retorna l'URL. És la prova que valida la inscripció. Una per enviament (val per a
// tots els germans). Si no arriba signatura, retorna "".
function saveSignature(sig, settings, payload, id) {
  if (!sig || !sig.dataBase64) return "";
  var folder = getUploadFolder(settings, payload);
  var stamp = Utilities.formatDate(new Date(), "Europe/Madrid", "yyyy-MM-dd_HH-mm");
  var fileName = "Signatura - " + (id || stamp) + ".png";
  var blob = Utilities.newBlob(Utilities.base64Decode(sig.dataBase64), sig.mimeType || "image/png", fileName);
  var file = folder.createFile(blob);
  return file.getUrl();
}

/* ---------- Staging: pujada en segon pla des del formulari ----------
   El formulari puja cada foto a una carpeta temporal mentre l'usuari acaba; en
   enviar, només passa la referència (id) i saveFiles la mou a la carpeta final.
   Si no s'envia (treta o pàgina abandonada) s'esborra; cleanupStagedFiles() neteja
   els orfes amb un activador horari. */
function getStagingFolder(settings) {
  var root = getOrCreateFolder(DriveApp.getRootFolder(), (settings && settings.carpeta_fitxers) || "Inscripcions - fitxers");
  return getOrCreateFolder(root, "_temporals");
}
function handleStagedUpload(p) {
  try {
    if (!p.dataBase64) return { ok: false, error: "no data" };
    var settings = readSettings(String(p.form || "").trim());
    var folder = getStagingFolder(settings);
    var blob = Utilities.newBlob(Utilities.base64Decode(p.dataBase64), p.mimeType || "application/octet-stream", p.name || "foto");
    var file = folder.createFile(blob);
    return { ok: true, fileId: file.getId() };
  } catch (err) { return { ok: false, error: String(err) }; }
}
function handleStagedDelete(p) {
  try {
    if (!p.fileId) return { ok: true };
    var staging = getStagingFolder(readSettings(String(p.form || "").trim()));
    var file = DriveApp.getFileById(p.fileId);
    // Seguretat: només esborrem si el fitxer és dins la carpeta temporal.
    var parents = file.getParents(), inStaging = false;
    while (parents.hasNext()) { if (parents.next().getId() === staging.getId()) { inStaging = true; break; } }
    if (inStaging) file.setTrashed(true);
  } catch (err) {}
  return { ok: true };
}
// Activador horari (Activadors → cleanupStagedFiles → cada hora): esborra els fitxers temporals
// orfes de més de 24h que no s'han arribat a enviar mai, i omple en segon pla les targetes que
// falten reutilitzant-les d'altres campus (feina lenta que abans alentia l'enviament).
function cleanupStagedFiles() {
  try {
    var staging = getStagingFolder(readSettings(""));
    var cutoff = Date.now() - 24 * 3600 * 1000;
    var files = staging.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
    }
  } catch (e) {}
  try { reuseMissingFilesJob(); } catch (e) {}
}

// Premium en segon pla: per a cada inscripció recent on falti un fitxer (típicament la targeta
// sanitària), si el mateix nen ja el va adjuntar en un altre campus, en copiem la imatge a la
// carpeta d'aquest formulari i n'escrivim l'URL a la fila. Es feia abans dins de l'enviament;
// ara va aquí perquè escanejar altres fulls és lent i no ha de fer esperar la família.
function reuseMissingFilesJob() {
  resetCache();
  var formIds = readForms().map(function (f) { return f.id; });
  if (formIds.indexOf("") === -1) formIds.unshift("");          // inclou el formulari per defecte
  var cutoff = Date.now() - 3 * 24 * 3600 * 1000;               // només inscripcions dels últims 3 dies

  formIds.forEach(function (form) {
    var settings = readSettings(form);
    if (/^(no|false|0)$/i.test(String(settings.reutilitzar_fitxers || ""))) return;
    var fileFields = readFields(form).filter(function (f) { return f.tipo === "file"; }).map(function (f) { return f.id; });
    if (!fileFields.length) return;

    var data = readSubmissionRows(form);
    if (!data.rows.length) return;

    data.rows.forEach(function (row) {
      var ts = (row.Timestamp instanceof Date) ? row.Timestamp.getTime() : new Date(row.Timestamp).getTime();
      if (isNaN(ts) || ts < cutoff) return;   // només recents (evita reescanejar tot l'històric)

      var have = [], missing = false;
      fileFields.forEach(function (fid) {
        if (/https?:\/\//.test(String(row[fid] || ""))) have.push({ field: fid });
        else missing = true;
      });
      if (!missing) return;   // ja té tots els fitxers → res a fer

      var filePayload = { data: row, formName: str(row.Formulario) || form, form: form };
      var reused = reuseChildFilesFromOtherForms({ data: row, files: have }, settings, filePayload, have);
      if (reused && reused.length) {
        var byField = {};
        reused.forEach(function (s) { (byField[s.field] = byField[s.field] || []).push(s.url); });
        setRowFileUrls(form, str(row.ID), byField);
      }
    });
  });
}
// Carpeta destí: arrel/<carpeta_fitxers>/<hoja del formulari>.
// El nom de la subcarpeta és el mateix valor de la columna "hoja" de la pestanya
// Formularios (via subsSheetName), de manera que la carpeta de fitxers coincideix
// amb la pestanya on es guarden les inscripcions d'aquell formulari.
function getUploadFolder(settings, payload) {
  var form = (payload && payload.form) || "";
  var sub = subsSheetName(form);
  // Fallbacks per si de cas (formulari sense hoja ni id).
  if (!sub) sub = (payload && payload.formName) || (payload && payload.campusName) || (payload && payload.campusId) || "General";
  sub = String(sub).replace(/[\/\\]+/g, "-").trim() || "General";

  // Cau de l'ID de carpeta: evita els getFoldersByName (arrel + subcarpeta) a cada enviament amb
  // fitxers, que són ~0.5s. Així moure una foto és més ràpid.
  var cache = CacheService.getScriptCache();
  var ckey = "folder_" + sub;
  var fid = cache.get(ckey);
  if (fid) { try { return DriveApp.getFolderById(fid); } catch (e) {} }

  var root = getOrCreateFolder(DriveApp.getRootFolder(), settings.carpeta_fitxers || "Inscripcions - fitxers");
  var folder = getOrCreateFolder(root, sub);
  try { cache.put(ckey, folder.getId(), 21600); } catch (e) {}
  return folder;
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

/* ---------- Premium: reutilitzar fitxers d'altres campus ----------
   Si un nen no adjunta un fitxer (típicament la targeta sanitària) però ja el va adjuntar en
   un altre formulari/campus, en copiem la imatge a la carpeta d'aquest formulari i en posem
   l'URL a la fila, com si l'hagués tornat a adjuntar.
   - Es pot desactivar amb l'ajust "reutilitzar_fitxers" = no/false.
   - Es pot limitar a camps concrets amb "reutilitzar_camps" = id1,id2 (per defecte, tots els
     camps de tipus fitxer).
   - L'emparellament del nen és per nom + cognoms + data de naixement (dades del full), exigint
     com a mínim el nom i un segon identificador, per evitar copiar el document d'un altre nen. */
function reuseChildFilesFromOtherForms(child, settings, payload, savedSoFar) {
  if (settings && /^(no|false|0)$/i.test(String(settings.reutilitzar_fitxers || ""))) return [];

  var currentForm = String(payload.form || "").trim();
  var fileFields = readFields(currentForm).filter(function (f) { return f.tipo === "file"; });
  if (!fileFields.length) return [];

  // Limitació opcional a camps concrets
  var only = String((settings && settings.reutilitzar_camps) || "").split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (only.length) fileFields = fileFields.filter(function (f) { return only.indexOf(f.id) !== -1; });

  // Camps de fitxer que han quedat buits en aquesta inscripció
  var have = {};
  (savedSoFar || []).forEach(function (s) { have[s.field] = true; });
  (child.files || []).forEach(function (f) { have[f.field] = true; });
  var missing = fileFields.filter(function (f) { return !have[f.id]; });
  if (!missing.length) return [];

  var key = buildChildKey(child.data || {});
  if (!key) return [];   // sense identitat fiable → no arrisquem cap còpia

  var formIds = readForms().map(function (f) { return f.id; });
  if (formIds.indexOf("") === -1) formIds.unshift("");   // inclou el formulari per defecte

  var folder = null;     // crea/obre la carpeta només si realment trobem alguna cosa
  var out = [];
  missing.forEach(function (f) {
    var urls = findPreviousFileUrls(key, f.id, currentForm, formIds);
    if (!urls.length) return;
    if (!folder) folder = getUploadFolder(settings, payload);
    urls.forEach(function (url) {
      var copied = copyDriveFileToFolder(url, folder, payload, f.id);
      if (copied) out.push({ field: f.id, name: copied.name, url: copied.url });
    });
  });
  return out;
}

// Clau d'identitat d'un nen: nom + cognoms + data de naixement (normalitzats). Funciona igual
// amb les dades entrants (claus = id de camp) i amb una fila del full (claus = capçalera = id).
function buildChildKey(data) {
  var nom = "";
  for (var k in data) {
    // Exclou "cognom/apellido" (que contenen la subcadena "nom") i contactes (tutor/pare/mare).
    if (/nom|nombre/i.test(k) && !/cognom|apellido|tutor|pare|mare|padre|madre/i.test(k) && str(data[k])) { nom = data[k]; break; }
  }
  var cognoms = pickFirstValue(data, [/cognom/i, /apellido/i]);
  var nkey = normalizeKeyPart(nom);
  var ckey = normalizeKeyPart(cognoms);
  var bkey = birthKey(findBirthdate(data));
  if (!nkey) return "";
  if (!ckey && !bkey) return "";   // cal un segon identificador a banda del nom
  return nkey + "|" + ckey + "@" + bkey;
}
// Normalitza una data (Date del full o text del formulari) a "yyyy-MM-dd" sense dependre del fus.
function birthKey(v) {
  if (!v) return "";
  if (v instanceof Date) return isNaN(v.getTime()) ? "" : v.getFullYear() + "-" + pad2(v.getMonth() + 1) + "-" + pad2(v.getDate());
  var s = str(v).trim();
  var m = s.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (m) return m[1] + "-" + pad2(m[2]) + "-" + pad2(m[3]);
  m = s.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/);
  if (m) return m[3] + "-" + pad2(m[2]) + "-" + pad2(m[1]);
  var d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }

// Busca als altres formularis una fila del MATEIX nen amb fitxer al camp donat. Retorna els URLs.
function findPreviousFileUrls(key, fieldId, currentForm, formIds) {
  var currentSheet = subsSheetName(currentForm);
  var seen = {};
  for (var i = 0; i < formIds.length; i++) {
    var sheetName = subsSheetName(formIds[i]);
    if (sheetName === currentSheet || seen[sheetName]) continue;   // mai el full actual, ni repetits
    seen[sheetName] = true;
    var data = readSubmissionRows(formIds[i]);
    if (!data.rows.length || data.header.indexOf(fieldId) === -1) continue;
    for (var r = data.rows.length - 1; r >= 0; r--) {   // de la més recent a la més antiga
      var cell = str(data.rows[r][fieldId]);
      if (!cell || !/https?:\/\//.test(cell)) continue;
      if (buildChildKey(data.rows[r]) === key) {
        return cell.split("\n").map(function (s) { return s.trim(); }).filter(function (s) { return /https?:\/\//.test(s); });
      }
    }
  }
  return [];
}

// Copia un fitxer de Drive (identificat per la seva URL) a la carpeta destí, amb el nom estàndard.
function copyDriveFileToFolder(url, folder, payload, fieldId) {
  var m = String(url).match(/[-\w]{25,}/);
  if (!m) return null;
  try {
    var src = DriveApp.getFileById(m[0]);
    var childName = (pickChild(payload) || "document").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") || "document";
    var label = String(fieldId).replace(/[^\w\-]+/g, "_");
    var copy = src.makeCopy(childName + " - " + label + reuseExt(src.getName()), folder);
    return { name: copy.getName(), url: copy.getUrl() };
  } catch (e) { return null; }
}
function reuseExt(name) {
  var m = String(name || "").match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? "." + m[1].toLowerCase() : "";
}

// Afegeix URLs de fitxers a les columnes corresponents d'una fila ja desada
// (identificada pel seu ID). L'usa el post-procés de reutilització al trigger.
function setRowFileUrls(form, id, byField) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(subsSheetName(form));
  if (!sheet || sheet.getLastRow() < 2) return;
  var lastCol = sheet.getLastColumn(), lastRow = sheet.getLastRow();
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var idCol = header.indexOf("ID");
  if (idCol === -1) return;
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var rowIndex = -1;
  for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]) === String(id)) { rowIndex = i + 2; break; } }
  if (rowIndex === -1) return;
  Object.keys(byField).forEach(function (field) {
    var col = header.indexOf(field);
    if (col === -1) return;
    var cell = sheet.getRange(rowIndex, col + 1);
    var ex = String(cell.getValue() || "").trim();
    cell.setValue(ex ? ex + "\n" + byField[field].join("\n") : byField[field].join("\n"));
  });
}

// El full mostra les dates (Timestamp inclòs) en la zona horària del document. La forcem a
// Espanya perquè l'hora de recepció sigui sempre la d'aquí, independentment d'on s'executi el
// script o de com tingui configurat el full el propietari. Idempotent: només escriu si cal.
function ensureSpainTimezone(ss) {
  try { if (ss.getSpreadsheetTimeZone() !== "Europe/Madrid") ss.setSpreadsheetTimeZone("Europe/Madrid"); } catch (e) {}
}

/* ---------- Guardar fila ----------
   Columnes: Timestamp · ID · [camps no-nota, amb Edat després de la data
   de naixement] · una columna 1/0 per setmana · Setmanes (text) */
function saveRow(id, payload, data) {
  var form = String(payload.form || "").trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSpainTimezone(ss);   // l'hora de recepció (Timestamp) sempre en hora d'Espanya
  var name = subsSheetName(form);
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);

  var fields = readFields(form).filter(function (f) { return f.tipo !== "nota"; });
  var weeks = readWeekDefs(form);   // només cal id/etiqueta per planificar columnes (no comptar places)
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
  plan.push("Signatura");

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
    if (col === "Signatura") return payload.signatura || "";
    if (col === "Grups") {
      if (payload.grups) return payload.grups;
      // El grup (vestidor) sempre queda desat: per defecte, el que toca per edat a cada setmana
      // inscrita. En moure el nen/a de grup al panell, s'actualitzarà aquest valor.
      var gconf = groupsConfig(readSettings(form));
      var autoColor = autoGroupColor(edat, gconf);
      var gmap = {};
      (payload.weeks || []).forEach(function (w) { gmap[w] = autoColor; });
      return serializeGroupOverrides(gmap);
    }
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
  // Cau curta entre peticions (CacheService): obrir el formulari recompta les places de cada
  // setmana, cosa que requereix llegir TOT el full d'inscripcions. Com que molta gent obre el
  // formulari i poca l'envia, evitem aquesta lectura pesada en cada càrrega. Les places són
  // informatives (no s'imposen al servidor), així que uns segons de marge no passa res.
  var cache = CacheService.getScriptCache();
  var ckey = "wkcount_" + form;
  var hit = cache.get(ckey);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  var counts = {};
  var data = readSubmissionRows(form);          // cau per petició
  var weeks = readTable(SHEETS.weeks).filter(function (r) { return r.id && rowMatchesForm(r, form); }).map(function (r) { return String(r.id).trim(); });
  weeks.forEach(function (wid) {
    var c = 0;
    data.rows.forEach(function (row) { if (Number(row[wid]) === 1) c++; });
    counts[wid] = c;
  });
  try { cache.put(ckey, JSON.stringify(counts), 20); } catch (e) {}
  return counts;
}

/* ---------- Correu ----------
   El correu de confirmació s'envia SÍNCRONAMENT dins de doPost (vegeu sendConfirmation més avall),
   de manera que arriba a l'instant. Abans s'encuava i el processava un trigger, però els triggers
   de l'Apps Script NO són immediats (poden trigar minuts a disparar-se) → el correu arribava tard.

   Les funcions de sota (processEmailQueue + finalizeJob) ja NO s'usen per a enviaments nous: només
   queden per BUIDAR, un sol cop, la cua que pogués haver deixat la versió anterior (inscripcions
   enviades just abans de tornar a desplegar). Quan la cua queda buida i els triggers pendents es
   disparen, s'autodesinstal·len i aquestes funcions queden inactives. */

// Buida un job pendent de la cua antiga: mou els fitxers que faltaven, reutilitza els d'altres
// campus i envia la confirmació. Només s'executa per a feina deixada per la versió anterior.
function finalizeJob(job) {
  var settings = readSettings(String(job.form || "").trim());
  try {
    (job.rows || []).forEach(function (r, idx) {
      var child = (job.children && job.children[idx]) || {};
      var cdata = child.data || r.data || {};
      var filePayload = { data: cdata, formName: job.formName, form: job.form };

      // 1) Mou ara els fitxers pujats en segon pla (staging) a la carpeta final i escriu-ne
      //    els URLs a la fila ja desada. Es fa aquí —no a la petició— perquè les operacions de
      //    Drive (reanomenar + moure) són lentes i eren el que feia lent l'enviament del formulari.
      var moved = saveFiles(r.refFiles || [], settings, filePayload, r.id);
      var savedSoFar = (r.savedFiles || []).concat(moved);
      applyRowFileUrls(job.form, r.id, moved, r);

      // 2) Premium: reutilitza fitxers d'altres campus si en falta algun.
      var reused = reuseChildFilesFromOtherForms({ data: cdata, files: savedSoFar }, settings, filePayload, savedSoFar);
      applyRowFileUrls(job.form, r.id, reused, r);

      r.savedFiles = savedSoFar.concat(reused);
    });
  } catch (e) {}
  sendConfirmation(settings, { form: job.form, formName: job.formName, campusName: job.campusName, shared: job.shared, children: job.children }, job.rows);
}

// Escriu un conjunt de fitxers desats a les columnes corresponents de la fila (per ID) i els
// afegeix també a r.data, perquè surtin al correu de confirmació com a "(fitxer adjuntat)".
function applyRowFileUrls(form, id, saved, r) {
  if (!saved || !saved.length) return;
  var byField = {};
  saved.forEach(function (s) { (byField[s.field] = byField[s.field] || []).push(s.url); });
  setRowFileUrls(form, id, byField);
  Object.keys(byField).forEach(function (f) {
    var ex = str(r.data[f]); r.data[f] = ex ? ex + "\n" + byField[f].join("\n") : byField[f].join("\n");
  });
}
// LEGACY (només transició): buida la cua que pogués haver deixat la versió asíncrona anterior i
// elimina els seus triggers pendents (s'autodesinstal·la). Els enviaments nous ja no fan servir
// cua: el correu s'envia síncronament a doPost. Quan no queden jobs, aquesta funció no fa res.
function processEmailQueue() {
  var qlock = LockService.getScriptLock();
  if (!qlock.tryLock(10000)) return;   // si una inscripció té el lock, ja es buidarà més tard
  var jobs = [];
  try {
    // Esborra els triggers pendents d'aquesta funció (els crea només la versió antiga).
    try {
      ScriptApp.getProjectTriggers().forEach(function (t) {
        if (t.getHandlerFunction() === "processEmailQueue") ScriptApp.deleteTrigger(t);
      });
    } catch (e) {}
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf("emailq_") !== 0) return;
      jobs.push(all[k]);
      try { props.deleteProperty(k); } catch (e) {}
    });
  } finally {
    try { qlock.releaseLock(); } catch (e) {}
  }
  // Fora del lock: mou els fitxers a Drive i envia els correus pendents.
  jobs.forEach(function (raw) { try { finalizeJob(JSON.parse(raw)); } catch (e) {} });
}

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

  // ── Versió en text pla (fallback robust) ─────────────────────────────────
  // S'envia com a part alternativa: si un client de correu no renderitza bé l'HTML, mostra
  // aquest resum net en comptes d'ensenyar el missatge "a trossos".
  var txt = [intro, ""];
  if (payload.campusName) txt.push("Casal: " + payload.campusName);
  Object.keys(first).forEach(function (k) {
    if (fieldGroup[k] === childGroupName || isInternal(k)) return;
    if (first[k] === "" || first[k] == null) return;
    txt.push((labels[k] || k) + ": " + (String(first[k]).indexOf("http") === 0 ? "(fitxer adjuntat)" : fmtDate(first[k])));
  });
  rows.forEach(function (r, idx) {
    var d = r.data || {};
    var nm = ""; for (var k in d) { if (/nom/i.test(k) && !/tutor|pare|mare/i.test(k) && !nm) nm = str(d[k]); }
    txt.push("", (multi ? "— Jugador/a " + (idx + 1) + (nm ? " · " + nm : "") : "— " + (nm || "Jugador/a")));
    Object.keys(d).forEach(function (k) {
      if (fieldGroup[k] !== childGroupName || isInternal(k)) return;
      if (d[k] === "" || d[k] == null) return;
      txt.push("  " + (labels[k] || k) + ": " + (String(d[k]).indexOf("http") === 0 ? "(fitxer adjuntat)" : fmtDate(d[k])));
    });
    if (r.weekLabels && r.weekLabels.length) txt.push("  Setmanes: " + r.weekLabels.join(", "));
    var pe = (payload.children && payload.children[idx]) || {};
    if (pe.preu != null && pe.preu > 0) txt.push("  Preu: " + pe.preu + " €");
  });
  var textBody = txt.join("\n");

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

  MailApp.sendEmail({ to: to, subject: subject, body: textBody, htmlBody: html, name: camp, replyTo: settings.email_contacto || undefined });
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
  // Cau curta entre peticions (CacheService): readTable només llegeix fulls de CONFIGURACIÓ
  // (Ajustes, Campos, Semanas, Formularios, Campus), que canvien molt poc. Així obrir el
  // formulari i desar una inscripció no els rellegeixen del full cada vegada —que era una part
  // important del temps d'enviament. El full d'inscripcions NO passa per aquí. Si edites la
  // configuració al full i vols veure-ho a l'instant, executa clearConfigCache().
  var sc = CacheService.getScriptCache();
  var ckey = "tbl_" + name;
  var hit = sc.get(ckey);
  if (hit != null) { try { var arr = JSON.parse(hit); _cache.tables[name] = arr; return arr; } catch (e) {} }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  var out = [];
  if (sheet && sheet.getLastRow() >= 2) {
    var values = sheet.getDataRange().getValues();
    var header = values[0].map(function (h) { return String(h).trim(); });
    for (var i = 1; i < values.length; i++) {
      var obj = {}, empty = true;
      for (var c = 0; c < header.length; c++) {
        if (!header[c]) continue;
        obj[header[c]] = values[i][c];
        if (values[i][c] !== "" && values[i][c] != null) empty = false;
      }
      if (!empty) out.push(obj);
    }
  }
  try { sc.put(ckey, JSON.stringify(out), 30); } catch (e) {}
  _cache.tables[name] = out;
  return out;
}
// Buida la cau dels fulls de configuració (executa-ho després d'editar Ajustes/Campos/Semanas
// al full si vols veure el canvi immediatament, sense esperar els 30s de marge).
function clearConfigCache() {
  var sc = CacheService.getScriptCache();
  sc.removeAll([SHEETS.settings, SHEETS.fields, SHEETS.weeks, SHEETS.forms, SHEETS.campus].map(function (n) { return "tbl_" + n; }));
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

/* ---------- Configuració des del panell ----------
   La pàgina "Configuració" del panell llegeix i reescriu les 4 pestanyes de
   configuració de l'Excel (Formularios, Semanas, Ajustes, Campos) perquè no
   calgui obrir el full. MAI toca les pestanyes d'inscripcions. */
function configSheetNames() { return [SHEETS.forms, SHEETS.weeks, SHEETS.settings, SHEETS.fields]; }

// Retorna les pestanyes tal com es veuen al full (matriu de textos), per editar-les.
function adminConfigGet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = {};
  configSheetNames().forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() < 1) { out[name] = { header: [], rows: [] }; return; }
    // getDisplayValues: dates i números com es veuen al full → round-trip segur en text.
    var values = sheet.getDataRange().getDisplayValues();
    out[name] = { header: values[0].map(function (h) { return String(h).trim(); }), rows: values.slice(1) };
  });
  return { ok: true, sheets: out };
}

// Reescriu una pestanya de configuració sencera amb el que envia el panell
// (cobreix afegir, editar i esborrar files d'un sol cop; són fulls petits).
function adminConfigSave(name, header, rows) {
  name = str(name);
  if (configSheetNames().indexOf(name) === -1) return { ok: false, error: "sheet not allowed" };
  header = (header || []).map(function (h) { return str(h); });
  if (!header.length || !header.some(function (h) { return h; })) return { ok: false, error: "capçalera buida" };
  var width = header.length;
  var body = (rows || []).map(function (r) {
    var row = [];
    for (var c = 0; c < width; c++) row.push(r && r[c] != null ? String(r[c]) : "");
    return row;
  }).filter(function (r) { return r.some(function (v) { return String(v).trim() !== ""; }); });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clearContents();
  var values = [header].concat(body);
  sheet.getRange(1, 1, values.length, width).setValues(values);
  clearConfigCache();   // el formulari públic veu els canvis a l'instant
  return { ok: true, sheet: name, rows: body.length };
}

// Llista de formularis per al selector del panell (la pestanya "Formularios" tal qual).
function adminForms() {
  var forms = readForms().map(function (f) { return { id: f.id, nombre: f.nombre || f.id, estacio: f.estacio, habilitado: f.habilitado, dashboardActiu: f.dashboardActiu }; });
  if (!forms.length) {
    var g = readSettings("");
    forms = [{ id: "", nombre: str(g.nombre_campus) || "Formulari", estacio: "", habilitado: true, dashboardActiu: true }];
  }
  return forms;
}

// Router de les accions d'administració.
function handleAdmin(p) {
  try {
    // El panell ha de veure SEMPRE la configuració actual del full (formularis actius/inactius,
    // ajustos...). Per a les accions de càrrega buidem la cau de config, de manera que en
    // canviar l'Excel i refrescar el panell els canvis es vegin a l'instant, sense esperar que
    // expiri la cau ni netejar-la a mà.
    if (p.action === "admin_login" || p.action === "admin_session" || p.action === "admin_data" ||
        p.action === "admin_overview" || p.action === "admin_list") {
      clearConfigCache();
    }
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
    if (!form) form = defaultFormId();
    switch (p.action) {
      case "admin_session": {    // restaura la sessió sense enviar el PIN de nou
        var sc = readSettings("");
        return { ok: true, forms: adminForms(), settings: { nombre_campus: str(sc.nombre_campus), club: str(sc.club) } };
      }
      case "admin_data": {       // overview + llista (+ formularis, per refrescar quins són actius)
        var ov = adminOverview(form);
        var ls = adminList(form);
        return { ok: true, overview: ov, list: ls.rows, forms: adminForms() };
      }
      case "admin_overview":    return adminOverview(form);
      case "admin_list":        return adminList(form);
      case "admin_set_status":  return adminSetStatus(form, p.id, p.estat);
      case "admin_set_payment": return adminSetPayment(form, p.id, p.weeks, p.row);
      case "admin_set_weeks":   return adminSetWeeks(form, p.id, p.weeks, p.row, p.preu);
      case "admin_set_group":   return adminSetGroup(form, p.id, p.week, p.color, p.row);
      case "admin_set_groups_config": return adminSetGroupsConfig(p.config);
      case "admin_resend":      return adminResend(form, p.id);
      case "admin_reminder":    return adminReminder(form, p.ids || (p.id ? [p.id] : []));
      case "admin_receipt":     return adminReceipt(form, p.ids || (p.id ? [p.id] : []));
      case "admin_update":      return adminUpdate(form, p.id, p.patch);
      case "admin_update_fields": return adminUpdateFields(form, p.id, p.row, p.patch, p.preu, p.descompte);
      case "admin_config_get":  return adminConfigGet();
      case "admin_config_save": return adminConfigSave(p.sheet, p.header, p.rows);
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
  // Sempre en hora d'Espanya, perquè l'agrupació per dia del panell no depengui de la
  // zona horària on s'executi el script.
  return Utilities.formatDate(d, "Europe/Madrid", "yyyy-MM-dd");
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

// Omple la columna "Grups" de les files a què els falti: a cada setmana inscrita hi posa el
// grup (vestidor) que toca per edat. Així el camp mai queda buit a l'Excel; en moure un nen/a
// de grup, només se'n canvia el valor d'aquella setmana. Escriu en bloc (una sola operació) i
// només quan realment falta alguna cosa, de manera que en càrregues posteriors no fa res.
function backfillGroups(form, data) {
  var sheet = data.sheet;
  if (!sheet || !data.rows.length) return;
  var groups = groupsConfig(readSettings(form));
  var weekIds = readWeeks(form).map(function (w) { return w.id; });
  if (!weekIds.length) return;
  var col = ensureColumn(sheet, data.header, "Grups");
  var n = data.rows.length;
  var colVals = sheet.getRange(2, col, n, 1).getValues();
  var changed = false;
  data.rows.forEach(function (r, i) {
    var registered = rowRegisteredWeeks(r, weekIds);
    if (!registered.length) return;
    var map = parseGroupOverrides(str(colVals[i][0]));
    var auto = autoGroupColor(num(r.Edat), groups);
    var rowChanged = false;
    registered.forEach(function (w) { if (!map[w]) { map[w] = auto; rowChanged = true; } });
    if (rowChanged) { var v = serializeGroupOverrides(map); colVals[i][0] = v; r.Grups = v; changed = true; }
  });
  if (changed) sheet.getRange(2, col, n, 1).setValues(colVals);
}

// Llista completa per a la taula + detall.
function adminList(form) {
  var data = readSubmissionRows(form);
  backfillGroups(form, data);   // garanteix que tots els nens/es tenen grup desat (per edat)
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
      // id/tipo/opciones: el panell els fa servir per al mode edició (quin input pinta).
      detail.push({ id: f.id, tipo: f.tipo, opciones: f.opciones || "", label: labels[f.id] || f.id, value: String(v), grup: groups[f.id] || "", esJugador: groups[f.id] === childGroup });
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
      rebutEnviat: str(row["Rebut enviat"]),
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
function adminSetPayment(form, id, weeks, rowNum) {
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var weekIds = readWeeks(form).map(function (w) { return w.id; });
  // Resolem per número de fila del full (únic) i no només per ID: dos germans poden compartir
  // ID i, buscant per ID, s'acabava escrivint sempre a la mateixa fila (l'estat no s'actualitzava
  // a la fila correcta). Compatible amb peticions antigues que només envien l'ID.
  var target = findRowByNumberOrId(data, rowNum, id);
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

// Canvia les setmanes d'una inscripció (altes/baixes d'última hora des del panell).
// Reescriu les columnes 1/0 de cada setmana i el text "Setmanes", poda de "Setmanes
// pagades" les que ja no estiguin inscrites i recalcula l'Estat. El preu NO es
// recalcula sol (els descomptes depenen de coses que el backend no sap): l'edita
// l'admin al mateix diàleg i, si arriba, s'escriu a la columna Preu.
function adminSetWeeks(form, id, weeks, rowNum, preu) {
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var weeksCfg = readWeeks(form);
  if (!weeksCfg.length) return { ok: false, error: "no weeks" };
  var weekIds = weeksCfg.map(function (w) { return w.id; });
  var target = findRowByNumberOrId(data, rowNum, id);
  if (!target) return { ok: false, error: "row not found" };

  var selected = (weeks || []).map(String).filter(function (w) { return weekIds.indexOf(w) !== -1; });
  if (!selected.length) return { ok: false, error: "Cal deixar almenys una setmana. Per donar de baixa la inscripció sencera, fes servir Anul·la." };

  // Columnes 1/0 per setmana (es creen si falten) + text llegible "Setmanes".
  weekIds.forEach(function (wid) {
    var col = ensureColumn(sheet, data.header, wid);
    sheet.getRange(target.__row, col, 1, 1).setValue(selected.indexOf(wid) !== -1 ? 1 : 0);
  });
  var labels = weeksCfg
    .filter(function (w) { return selected.indexOf(w.id) !== -1; })
    .map(function (w) { return w.nombre || w.id; });
  var setCol = ensureColumn(sheet, data.header, "Setmanes");
  sheet.getRange(target.__row, setCol, 1, 1).setValue(labels.join(", "));

  // Poda els pagaments de setmanes tretes i recalcula l'estat amb la nova llista.
  var paid = rowPaidWeeks(target, selected);
  var estat = computeEstat(paid, selected);
  var paidCol = ensureColumn(sheet, data.header, "Setmanes pagades");
  var estatCol = ensureColumn(sheet, data.header, "Estat");
  sheet.getRange(target.__row, paidCol, 1, 1).setValue(paid.join(", "));
  sheet.getRange(target.__row, estatCol, 1, 1).setValue(estat);

  var preuOut = num(target.Preu) || 0;
  if (preu != null && String(preu) !== "") {
    preuOut = Number(preu) || 0;
    var preuCol = ensureColumn(sheet, data.header, "Preu");
    sheet.getRange(target.__row, preuCol, 1, 1).setValue(preuOut);
  }
  return { ok: true, id: id, weekIds: selected, setmanes: labels.join(", "), paidWeeks: paid, estat: estat, preu: preuOut };
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

// Troba una fila de forma robusta: primer pel número de fila del full (únic) i, si l'ID el
// confirma, la retorna; si no, cau a buscar per ID. Així dues files amb el mateix ID (germans)
// no es confonen, però seguim sent compatibles amb peticions antigues que només envien l'ID.
function findRowByNumberOrId(data, rowNum, id) {
  var n = Number(rowNum);
  if (n) {
    for (var i = 0; i < data.rows.length; i++) {
      if (Number(data.rows[i].__row) === n) {
        if (!id || str(data.rows[i].ID) === str(id)) return data.rows[i];
        break;   // la fila s'ha desplaçat (l'ID no quadra) → millor buscar per ID
      }
    }
  }
  var match = null;
  data.rows.forEach(function (r) { if (str(r.ID) === str(id)) match = r; });
  return match;
}

// Mou un jugador/a a un color de grup per a una setmana concreta.
// Si el color coincideix amb l'automàtic (per edat), s'esborra l'excepció.
function adminSetGroup(form, id, week, color, rowNum) {
  week = str(week); color = str(color).toLowerCase();
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  // Resolem la fila pel número de fila del full (únic), no per l'ID: dos germans poden compartir
  // ID i, buscant per ID, sempre s'acabava escrivint a la mateixa fila (no es podien separar de grup).
  var target = findRowByNumberOrId(data, rowNum, id);
  if (!target) return { ok: false, error: "row not found" };

  var map = parseGroupOverrides(str(target.Grups));
  if (!week) return { ok: false, error: "week missing" };
  // El grup sempre queda desat per a totes les setmanes inscrites: primer omplim les que
  // faltin amb el valor per edat, i després assignem el color triat a la setmana moguda.
  // Així el camp mai queda buit i moure un nen/a a qualsevol grup (inclòs el vermell) es desa.
  var groups = groupsConfig(readSettings(form));
  var auto = autoGroupColor(num(target.Edat), groups);
  rowRegisteredWeeks(target, readWeeks(form).map(function (w) { return w.id; }))
    .forEach(function (w) { if (!map[w]) map[w] = auto; });
  if (color) map[week] = color; else map[week] = auto;

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
      if (!rf) { sheet.getRange(i + 1, vc + 1, 1, 1).setValue(value); invalidateSettingsCache(); return; }
    }
  }
  var row = []; for (var j = 0; j < header.length; j++) row.push("");
  row[kc] = key; row[vc] = value;
  sheet.appendRow(row);
  invalidateSettingsCache();
}
// Després d'escriure a Ajustes, buida'n la cau perquè el canvi es vegi a l'instant.
function invalidateSettingsCache() {
  try { CacheService.getScriptCache().remove("tbl_" + SHEETS.settings); } catch (e) {}
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

/* ---------- Rebut de pagament ----------
   Envia un correu de rebut confirmant l'import JA PAGAT pel campus (formulari).
   Té en compte els pagaments parcials: l'import es calcula només sobre les setmanes
   pagades (preu × setmanes_pagades / setmanes_inscrites). El rebut és per família/correu:
   els germans comparteixen correu, així que s'agrupa per correu, s'envia un sol rebut amb
   l'import total de la família i es marca la columna "Rebut enviat" a totes les seves files. */
function adminReceipt(form, ids) {
  var settings = readSettings(form);
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var weeks = readWeeks(form);
  var weekIds = weeks.map(function (w) { return w.id; });
  var labelById = {};
  weeks.forEach(function (w) { labelById[w.id] = w.etiqueta || w.id; });

  function normEmail(r) { return String(findEmail(r) || "").trim().toLowerCase(); }

  // Correus implicats per les inscripcions seleccionades.
  var wanted = {};
  (ids || []).map(String).forEach(function (id) {
    data.rows.forEach(function (r) { if (str(r.ID) === id) { var e = normEmail(r); if (e) wanted[e] = true; } });
  });

  var col = ensureColumn(sheet, data.header, "Rebut enviat");
  var stamp = Utilities.formatDate(new Date(), "Europe/Madrid", "yyyy-MM-dd HH:mm");
  var sent = 0, lastTo = "";

  Object.keys(wanted).forEach(function (email) {
    var family = data.rows.filter(function (r) { return normEmail(r) === email; });
    if (!family.length) return;

    var totalPaid = 0, names = [], kids = [];
    family.forEach(function (r) {
      var registered = rowRegisteredWeeks(r, weekIds);
      var paid = rowPaidWeeks(r, registered);
      if (!paid.length) return;   // aquest jugador/a no té res pagat → no surt al rebut
      var preu = num(r.Preu) || 0;
      var amount = registered.length ? Math.round(preu * (paid.length / registered.length)) : 0;
      totalPaid += amount;
      // Totes les setmanes inscrites, marcant quines estan pagades (per pintar-les diferent).
      var labels = registered.map(function (w) { return { label: labelById[w] || w, paid: paid.indexOf(w) !== -1 }; });
      var nm = adminRowName(r, form) || "Jugador/a";
      if (names.indexOf(nm) === -1) names.push(nm);
      kids.push({ name: nm, weeks: labels, amount: amount });
    });
    if (totalPaid <= 0) return;   // encara no s'ha cobrat res → no hi ha rebut a enviar

    var to = family.map(findEmail).filter(Boolean)[0];
    if (!to) return;
    var formName = str(family[0].Formulario) || form;
    sendReceipt(settings, to, names, totalPaid, kids, formName);
    family.forEach(function (r) { sheet.getRange(r.__row, col, 1, 1).setValue(stamp); });
    sent++; lastTo = to;
  });

  return { ok: true, sent: sent, to: (sent === 1 ? lastTo : undefined) };
}

function sendReceipt(settings, to, names, totalPaid, kids, formName) {
  var camp = settings.nombre_campus || "Casal";
  var who = (names && names.length) ? names.join(", ") : "la inscripció";
  var subject = settings.email_rebut_asunto || ("Rebut de pagament · " + (formName || camp));
  var avui = Utilities.formatDate(new Date(), "Europe/Madrid", "dd/MM/yyyy");
  var intro = settings.email_rebut_intro ||
    ("Confirmem que hem rebut el pagament de " + who + (formName ? " per " + formName : "") + ". Aquí tens el teu rebut amb el detall per jugador/a. Moltes gràcies!");

  // Pill verda plena si està pagada; clara/buida (gris) si encara no aplica el pagament.
  function pill(w) {
    if (w && w.paid)
      return "<span style='display:inline-block;background:#16A34A;color:#fff;border-radius:999px;padding:5px 14px;font-size:12px;font-weight:700;margin:0 6px 6px 0'>" + esc(w.label) + "</span>";
    return "<span style='display:inline-block;background:#F4F7FB;color:#A7B3C9;border:1px solid #E2E8F4;border-radius:999px;padding:4px 13px;font-size:12px;font-weight:700;margin:0 6px 6px 0'>" + esc(w.label) + "</span>";
  }
  // Una targeta per jugador/a: nom + import + TOTES les seves setmanes (pagades i pendents).
  var multi = (kids || []).length > 1;
  var kidsBlock = (kids || []).map(function (k) {
    var pills = (k.weeks || []).map(pill).join("");
    return "<div style='border:1px solid #E2E8F4;border-radius:11px;padding:13px 15px;margin-bottom:10px'>" +
        "<table style='width:100%;border-collapse:collapse'><tr>" +
          "<td style='font-size:15px;font-weight:800;color:#0E2A63'>&#127953; " + esc(k.name) + "</td>" +
          "<td style='text-align:right;font-size:14px;font-weight:800;color:#15803D;white-space:nowrap;vertical-align:top'>" + k.amount + " &euro;</td>" +
        "</tr></table>" +
        (pills ? "<div style='margin-top:9px'>" + pills + "</div>" : "") +
      "</div>";
  }).join("");

  var html =
    "<!DOCTYPE html><html lang='ca'><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
    "<body style='margin:0;padding:0;background:#eef2f9'>" +
    "<div style='font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px 12px;color:#16233D'>" +
      // Capçalera amb segell de confirmació
      "<div style='background:linear-gradient(135deg,#0E2A63 0%,#16357C 55%,#1F5AE0 100%);border-radius:16px 16px 0 0;padding:32px 28px 26px;border-top:4px solid #16A34A;text-align:center'>" +
        "<div style='display:inline-block;width:58px;height:58px;line-height:58px;border-radius:50%;background:#16A34A;color:#ffffff;font-size:30px;font-weight:800;margin-bottom:14px'>&#10003;</div>" +
        "<div style='font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9DC0FF;font-weight:700;margin-bottom:6px'>&#127953; " + esc(camp) + "</div>" +
        "<div style='font-size:24px;font-weight:800;color:#ffffff;line-height:1.2'>Rebut de pagament</div>" +
      "</div>" +
      // Cos
      "<div style='background:#ffffff;border:1px solid #D6DEEC;border-top:none;padding:28px 30px'>" +
        "<p style='margin:0 0 22px;color:#4B5C7A;font-size:15px;line-height:1.65'>" + esc(intro) + "</p>" +
        "<div style='background:#DCFCE7;border-radius:12px;padding:18px 20px;margin-bottom:22px;text-align:center'>" +
          "<div style='font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#15803D;font-weight:700;margin-bottom:5px'>Import pagat" + (multi ? " (total)" : "") + "</div>" +
          "<div style='font-size:34px;font-weight:800;color:#15803D;line-height:1'>" + totalPaid + " &euro;</div>" +
        "</div>" +
        (kidsBlock ? "<div style='font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#7C90B2;font-weight:700;margin-bottom:10px'>" + (multi ? "Detall per jugador/a" : "Setmanes") + "</div>" + kidsBlock : "") +
      "</div>" +
      // Firma + data
      "<div style='background:#ffffff;border:1px solid #D6DEEC;border-top:1px solid #EEF3FB;border-radius:0 0 16px 16px;padding:22px 30px 26px'>" +
        "<div style='font-size:14px;color:#4B5C7A'>Una salutació cordial,</div>" +
        "<div style='font-size:16px;font-weight:800;color:#0E2A63;margin-top:3px'>" + esc(camp) + "</div>" +
        "<div style='font-size:12px;color:#9AA8C2;margin-top:12px'>Rebut em&egrave;s el " + esc(avui) + "</div>" +
      "</div>" +
    "</div></body></html>";

  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: camp, replyTo: settings.email_contacto || undefined });
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

// Edició completa d'una inscripció des del panell ("Edita nen/a"): rep un patch
// {campId: valor} amb NOMÉS camps definits al formulari (mai columnes internes ni
// fitxers), i opcionalment preu i descompte. Si canvia la data de naixement,
// recalcula la columna Edat (de la qual depenen els grups per edat).
function adminUpdateFields(form, id, rowNum, patch, preu, descompte) {
  patch = patch || {};
  var data = readSubmissionRows(form);
  var sheet = data.sheet;
  if (!sheet) return { ok: false, error: "sheet not found" };
  var target = findRowByNumberOrId(data, rowNum, id);
  if (!target) return { ok: false, error: "row not found" };

  var editable = {};
  readFields(form).forEach(function (f) { if (f.tipo !== "nota" && f.tipo !== "file") editable[f.id] = true; });

  var updated = {};
  Object.keys(patch).forEach(function (k) {
    if (!editable[k]) return;
    var v = patch[k] == null ? "" : String(patch[k]);
    var col = ensureColumn(sheet, data.header, k);
    sheet.getRange(target.__row, col, 1, 1).setValue(v);
    target[k] = v;
    updated[k] = v;
  });

  var edat = num(target.Edat);
  var touchedBirth = Object.keys(updated).some(function (k) { return /naix|nacim|birth/i.test(k); });
  if (touchedBirth) {
    edat = computeAge(findBirthdate(target));
    var ecol = ensureColumn(sheet, data.header, "Edat");
    sheet.getRange(target.__row, ecol, 1, 1).setValue(edat != null ? edat : "");
  }
  if (preu != null && String(preu) !== "") {
    target.Preu = Number(preu) || 0;
    var pcol = ensureColumn(sheet, data.header, "Preu");
    sheet.getRange(target.__row, pcol, 1, 1).setValue(target.Preu);
  }
  if (descompte != null) {
    target.Descompte = String(descompte);
    var dcol = ensureColumn(sheet, data.header, "Descompte");
    sheet.getRange(target.__row, dcol, 1, 1).setValue(target.Descompte);
  }

  // Retornem els camps derivats perquè el panell refresqui la taula sense recarregar.
  return {
    ok: true, id: id, updated: updated,
    nom: adminRowName(target, form),
    tutor: pickFirstValue(target, [/nom_tutor/i, /tutor/i]),
    email: findEmail(target),
    telefon: pickFirstValue(target, [/telefon|telefono|mobil|movil/i]),
    edat: edat != null ? edat : "",
    preu: num(target.Preu) || 0,
    descompte: str(target.Descompte)
  };
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
