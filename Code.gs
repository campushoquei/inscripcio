/* ============================================================
   Casal d'hoquei — Backend (Google Apps Script)

   Script LLIGAT al full: Extensions → Apps Script, enganxa això,
   Desplega → Aplicació web (executa com "Jo", accés "Qualsevol").
   Copia la URL /exec a SCRIPT_URL d'app.js.

   Pestanyes (vegeu SETUP.md):
     · Ajustes        (Clave | Valor)
     · Semanas        (id | etiqueta | fechas | precio | plazas)   [campus opcional]
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

function doGet(e) {
  try {
    var form = (e && e.parameter && e.parameter.form) ? String(e.parameter.form).trim() : "";
    return json(buildConfig(form));
  }
  catch (err) { return json({ error: String(err) }); }
}

function doPost(e) {
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

    removeExistingSubmissionRows(form, shared);

    // Cada fill puja els seus propis fitxers i l'URL va només a la seva fila.
    var rows = [];
    entries.forEach(function (child, idx) {
      var id = baseId + (entries.length > 1 ? "-" + (idx + 1) : "");
      var cd = child.data || {};
      var childFiles = child.files || [];
      // Passa les dades del fill concret perquè el nom del fitxer reflecteixi el seu nom,
      // no sempre el del primer fill.
      var saved = saveFiles(childFiles, settings, { data: cd }, id);
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
  return files.map(function (f) {
    var bytes = Utilities.base64Decode(f.dataBase64);
    var safe = (pickChild(payload) || id).replace(/[^\w\-]+/g, "_");
    var blob = Utilities.newBlob(bytes, f.mimeType || "application/octet-stream", safe + "__" + (f.field || "fitxer") + "__" + (f.name || "arxiu"));
    var file = folder.createFile(blob);
    return { field: f.field, name: file.getName(), url: file.getUrl() };
  });
}
function getUploadFolder(settings, payload) {
  var root = getOrCreateFolder(DriveApp.getRootFolder(), settings.carpeta_fitxers || "Inscripcions - fitxers");
  var campus = (payload && payload.campusName) || (payload && payload.campusId) || "General";
  return getOrCreateFolder(root, String(campus));
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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(subsSheetName(form));
  if (!sheet || sheet.getLastRow() < 2) return counts;
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  // compta via les columnes 1/0 de cada setmana
  var weeks = readTable(SHEETS.weeks).filter(function (r) { return r.id && rowMatchesForm(r, form); }).map(function (r) { return String(r.id).trim(); });
  if (sheet.getLastRow() < 2) return counts;
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  weeks.forEach(function (wid) {
    var col = header.indexOf(wid);
    if (col === -1) return;
    var c = 0;
    vals.forEach(function (r) { if (Number(r[col]) === 1) c++; });
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
        "<div style='font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#1F5AE0;font-weight:700;padding-bottom:8px;border-bottom:2px solid #EEF3FB;margin-bottom:12px'>Dades del tutor/a</div>" +
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
      ? "<div style='margin-top:14px;padding-top:13px;border-top:1px solid #EEF3FB'>" +
          "<div style='font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9DC0FF;font-weight:700;margin-bottom:8px'>Setmanes</div>" +
          "<div>" + weekPills + "</div>" +
        "</div>"
      : "";

    // Preu + descomptes
    var preuBlock = "";
    var preu = childEntry.preu;
    var descompte = childEntry.descompte && childEntry.descompte !== "-" ? childEntry.descompte : "";
    if (preu != null && preu > 0) {
      preuBlock =
        "<div style='background:#EEF3FB;border-left:4px solid #1F5AE0;border-radius:9px;padding:14px 16px;margin-top:16px'>" +
          "<table style='border-collapse:collapse;width:100%'><tr>" +
            "<td style='font-weight:700;color:#0E2A63;font-size:14px;vertical-align:middle'>Preu</td>" +
            "<td style='text-align:right;font-size:22px;font-weight:800;color:#1F5AE0;vertical-align:middle'>" + preu + " €</td>" +
          "</tr>" +
          (descompte ? "<tr><td colspan='2' style='font-size:11px;color:#6B7C99;padding-top:5px'>Descomptes aplicats: " + esc(descompte) + "</td></tr>" : "") +
          "</table>" +
        "</div>";
    }

    // Fitxers
    var filesNote = (r.savedFiles && r.savedFiles.length)
      ? "<p style='margin:12px 0 0;font-size:13px;color:#6B7C99'>📎 " + r.savedFiles.length + " document(s) rebut(s)</p>"
      : "";

    var blockTitle = multi
      ? ("Jugador/a " + (idx + 1) + (childName ? " · " + childName : ""))
      : (childName || "Jugador/a");

    return "<div style='border:1.5px solid #D6DEEC;border-radius:11px;overflow:hidden;margin-bottom:14px'>" +
             "<div style='background:#EEF3FB;background:linear-gradient(135deg,#EEF3FB 0%,#E2ECFB 100%);padding:13px 16px;border-bottom:1px solid #D6DEEC'>" +
               "<span style='font-size:15px;font-weight:800;color:#0E2A63'>🏑 " + esc(blockTitle) + "</span>" +
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

  var html =
    "<div style='font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#f0f4fb;padding:20px 10px;color:#16233D'>" +

      // Capçalera
      "<div style='background:#0E2A63;background:linear-gradient(135deg,#0E2A63 0%,#16357C 55%,#1F5AE0 100%);border-radius:14px 14px 0 0;padding:30px 28px;border-top:4px solid #1F5AE0'>" +
        "<div style='font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:#9DC0FF;font-weight:700;margin-bottom:10px'>🏑 " + esc(camp) + "</div>" +
        "<div style='font-size:25px;font-weight:800;color:#fff;line-height:1.2;margin-bottom:18px'>Inscripció confirmada!&nbsp;🎉</div>" +
        "<span style='display:inline-block;background:rgba(255,255,255,.18);border-radius:999px;padding:5px 16px;font-size:13px;color:#fff;font-weight:700'>" + badge + "</span>" +
      "</div>" +

      // Cos
      "<div style='background:#fff;border:1px solid #D6DEEC;border-top:none;border-radius:0 0 14px 14px;padding:28px 28px 24px'>" +
        "<p style='margin:0 0 24px;color:#4B5C7A;font-size:15px;line-height:1.65'>" + esc(intro) + "</p>" +
        sharedBlock +
        childrenBlocks +
      "</div>" +

    "</div>";

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
    "<td style='width:40%;padding:7px 16px 7px 0;color:#6B7C99;vertical-align:top;font-size:14px;word-break:break-word'>" + esc(k) + "</td>" +
    "<td style='width:60%;padding:7px 0;font-weight:600;color:#16233D;font-size:14px;word-break:break-word'>" + esc(fmtDate(v)) + "</td>" +
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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
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
