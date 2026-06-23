# Casal Hoquei — Guia de muntatge

Web estàtica (GitHub Pages) + Google Apps Script + Google Sheets.
Tota la parametrització es fa des del full de càlcul. De moment, **un sol casal (estiu)**;
l'opció de diversos casals (Nadal, Setmana Santa) amb habilitar/deshabilitar la deixem per a després.

```
Navegador (pare/mare)
   │  GET  ?action=config  → preguntes, setmanes, textos
   │  POST {inscripció + fitxers en base64}
   ▼
GitHub Pages (index.html, styles.css, app.js)
   ▼
Apps Script (Code.gs) ─► Google Sheet (base de dades)
                      ├─► Drive (carpeta amb la documentació)
                      └─► MailApp (correu de confirmació)
```

---

## 1. El full de càlcul — 3 pestanyes (noms exactes)

### `Ajustes`  (clau · valor)

| Clave | Valor |
|---|---|
| nombre_campus | Casal Hoquei Estiu 2026 |
| club | El plaer de jugar! |
| temporada | 2026 |
| lema | Inscripcions obertes |
| hero_titulo | Casal d'Hoquei d'Estiu |
| intro | Del 29 de juny al 31 de juliol. Tria les setmanes i adjunta la targeta sanitària. |
| email_contacto | coordinaciocpriudebitlles@gmail.com |
| email_asunto | Inscripció rebuda · Casal Hoquei Estiu 2026 |
| email_intro | Hem rebut la inscripció. Aquí tens el resum: |
| texto_boton | Enviar inscripció |
| mensaje_exito | T'hem enviat un correu amb el resum. |
| consentimiento | He llegit i accepto la política de protecció de dades del Club Esportiu E7. |
| setmanes_info | Preu: 1a setmana 80 € · 2a setmana / fam. nombrosa / 2n germà 70 € · jugadors C.P. Riudebitlles 70 € (2a setmana o 2n germà 60 €). |
| semanas_obligatorias | TRUE |
| carpeta_fitxers | Inscripcions - fitxers |
| form_defecto | estiu |
| setmanes_titulo | Setmanes del casal |

> `form_defecto` = quin formulari es mostra quan s'obre `index.html` sense `?form=`.
> `setmanes_titulo` = títol de la secció de setmanes/dies (es pot canviar per formulari amb la columna `form`).

### `Semanas`

Columnes: `id | etiqueta | fechas | precio | plazas | form`. La columna **`form`** diu a
quin formulari pertany cada fila — així cada casal té el seu propi nombre d'opcions:
l'estiu 5 setmanes, la primavera 4 dies, l'hivern 1 setmana.

| id | etiqueta | fechas | precio | plazas | form |
|---|---|---|---|---|---|
| S1 | Setmana 1 | 29 juny – 3 juliol | | | estiu |
| S2 | Setmana 2 | 6 – 10 juliol | | | estiu |
| S3 | Setmana 3 | 13 – 17 juliol | | 0 | estiu |
| S4 | Setmana 4 | 20 – 24 juliol | | | estiu |
| S5 | Setmana 5 | 27 – 31 juliol | | | estiu |
| D1 | Dissabte 1 | 11 abril | | | primavera |
| D2 | Dissabte 2 | 18 abril | | | primavera |
| D3 | Dissabte 3 | 25 abril | | | primavera |
| D4 | Dissabte 4 | 2 maig | | | primavera |
| H1 | Setmana única | 22 – 26 desembre | | | hivern |

- **`form`** = a quin formulari surt la fila. Buit = surt a **tots** els formularis.
- **plazas = 0** força "Complet" (com la S3). Buit = sense límit i sense comptador.
- Si poses un número (p. ex. 20), mostra "queden X" i bloqueja quan s'omple.
- Per a un casal que va per dies, l'`etiqueta` és el dia (p. ex. "Dissabte 1") i a `Ajustes`
  poses `setmanes_titulo | Tria els dies | primavera` perquè el títol no digui "Setmanes".
- `precio` el pots deixar buit si el preu s'explica a `setmanes_info`.

### `Campos`  (les preguntes — ja són les del teu formulari)

| id | etiqueta | tipo | opciones | obligatorio | ayuda | grupo | orden |
|---|---|---|---|---|---|---|---|
| nom_jugador | Nom i cognoms | text | | TRUE | | Dades del jugador/a | 1 |
| data_naixement | Data de naixement | date | | TRUE | Exemple: 18/11/2018 | Dades del jugador/a | 2 |
| sap_nedar | Sap nedar? | radio | Sí\|No | TRUE | | Dades del jugador/a | 3 |
| nom_tutor | Nom i cognoms del tutor/a | text | | TRUE | | Dades del pare/mare/tutor | 4 |
| nif | NIF | text | | TRUE | | Dades del pare/mare/tutor | 5 |
| adreca | Adreça | text | | TRUE | | Dades del pare/mare/tutor | 6 |
| poblacio | Població | text | | TRUE | | Dades del pare/mare/tutor | 7 |
| codi_postal | Codi postal | text | | TRUE | | Dades del pare/mare/tutor | 8 |
| telefon | Telèfon | tel | | TRUE | | Dades del pare/mare/tutor | 9 |
| email | Email | email | | TRUE | Hi enviarem la confirmació | Dades del pare/mare/tutor | 10 |
| aut_activitat | Autorització de l'activitat | radio | Sí\|No | TRUE | (text llarg de l'autorització) | Autoritzacions | 11 |
| aut_vehicle | Autorització de vehicle i cures | radio | Sí\|No | TRUE | (text llarg) | Autoritzacions | 12 |
| drets_imatge | Drets d'imatge | radio | Sí\|No | TRUE | (text llarg) | Autoritzacions | 13 |
| targeta_sanitaria | Còpia de la targeta sanitària | file | image/*,application/pdf | FALSE | Foto o PDF; pots saltar-ho si ja l'has enviat | Documentació | 14 |
| nota_lopd | Protecció de dades | nota | | FALSE | (text LOPD) | Protecció de dades | 15 |

Tipus disponibles: `text`, `email`, `tel`, `number`, `date`, `textarea`, `select`, `radio`, `checkbox`, `file`, **`nota`** (bloc de text sense resposta, per a avisos/autoritzacions/LOPD).
- `codi_postal` i `telefon` són **text** a propòsit: així no perden el zero inicial ni surten amb ".0".
- Posa el text llarg de cada autorització i del LOPD a la columna **ayuda** (a `radio` i `file` la mostra a sobre del control).

### `Inscripciones` (automàtica)
La crea el script. A més de les dades, hi escriu **una columna 1/0 per cada setmana** (S1…S5) i una columna **Edat** calculada de la data de naixement — el mateix que feies a mà a la "Hoja 1". Els fitxers hi queden com a **enllaç** al Drive.

> **Diversos fills en una sola inscripció.** Si un pare/mare apunta més d'un fill, pot
> prémer **"Afegir un altre fill/a"** al formulari i omplir les dades del tutor una sola
> vegada. A `Inscripciones` **cada fill queda en una fila pròpia** (amb les seves setmanes i
> edat), però comparteixen les dades del tutor i l'ID base (`INS-…-1`, `INS-…-2`). Es rep
> **un sol correu** amb el resum de tots els jugadors/es.
>
> El grup de camps que es repeteix per cada fill és el que es diu **"Dades del jugador/a"**
> (es detecta pel nom: jugador/alumne/fill/nen/infant). Tota la resta de grups (tutor,
> autoritzacions, documentació, LOPD) són compartits i s'omplen un sol cop.

---

## 2. Backend (Apps Script)

1. Al full: **Extensions → Apps Script**, enganxa `apps-script/Code.gs`, desa.
2. **Desplega → Nou desplegament → Aplicació web** · executa com **Jo** · accés **Qualsevol**.
3. Autoritza permisos: **full**, **Drive** (fitxers) i **Gmail** (correu).
4. Copia la URL `/exec`.

> Cada canvi de codi: **Gestiona desplegaments → edita → versió nova**.

## 3. Frontend (GitHub Pages)

1. A `app.js`, primera línia: `const SCRIPT_URL = "…/exec";` (buit = mode demo).
2. Puja els fitxers i activa Pages (repo públic).

## 4. Diversos formularis (estiu, primavera, Nadal…)

El sistema serveix **molts formularis amb un sol full i un sol desplegament**. Cada
formulari té la seva pròpia URL (`?form=...`) i la seva pestanya de respostes.

> De moment **tots els formularis surten idèntics** (comparteixen les mateixes preguntes).
> Per diferenciar-los, només cal omplir la columna `form` (veure més avall).

### La pestanya `Formularios` (opcional però recomanada)

| id | nombre | habilitado | hoja |
|---|---|---|---|
| primavera | Casal de Primavera 2027 | TRUE | |
| nadal | Casal de Nadal 2026 | FALSE | |

- **id**: el nom curt que va a la URL → `…/index.html?form=primavera`.
- **nombre**: títol bonic (surt al correu i a la columna `Formulario`).
- **habilitado**: `FALSE` = el formulari mostra "inscripcions tancades". `TRUE`/buit = obert.
- **hoja**: deixa-ho buit i el script crea sol la pestanya de respostes `Inscripciones_<id>`.

El **formulari per defecte** (obrir `index.html` sense `?form=`) fa servir les files
sense `form` i guarda a la pestanya `Inscripciones` de sempre. No cal tocar res perquè
segueixi funcionant com fins ara.

### La columna `form` a `Ajustes`, `Campos` i `Semanas`

Afegeix una columna **`form`** (al final, el nom exacte) a aquestes tres pestanyes:

- **Fila amb `form` buit** → és **compartida** per tots els formularis (el cas actual).
- **Fila amb `form` = `primavera`** → només apareix (o **sobreescriu**) al formulari primavera.

Exemples del que pots fer després a mà:
- A `Ajustes`, una fila `hero_titulo | Casal d'Hoquei d'Estiu` (form buit) i una altra
  `hero_titulo | Casal de Primavera | primavera`: cada formulari mostra el seu títol.
- A `Semanas`, deixa les setmanes d'estiu amb `form` buit o `estiu`, i afegeix les de
  primavera amb `form = primavera`.
- A `Campos`, afegeix una pregunta només per a un formulari posant-hi el seu `form`.

### Com crear un formulari nou (resum per a no-programadors)

1. Afegeix una fila a `Formularios` amb un `id` nou (p. ex. `primavera`) i `habilitado = TRUE`.
2. A `Semanas`, posa les setmanes/dates noves amb la columna `form = primavera`.
3. A `Ajustes`, canvia els textos que vulguis amb `form = primavera` (títol, intro, dates…).
4. Comparteix l'enllaç `…/index.html?form=primavera`.

No cal tornar a desplegar res ni tocar el codi. Les respostes apareixen soles a
`Inscripciones_primavera`.

---

## 5. Notes

- **Fitxers**: 5 MB/fitxer i 12 MB per enviament (a dalt d'`app.js`: `MAX_FILE_MB`, `MAX_TOTAL_MB`).
- **Drets d'imatge**: ara és Sí/No (com a la teva exportació). Legalment és més correcte que sigui opcional; deixa'l obligatori només si t'interessa forçar resposta.
- **Diversos casals**: quan ho vulguem, s'afegeix una pestanya `Campus` i una columna `campus` a `Semanas`; el codi ja ho contempla.
- **Correus**: Gmail ~100/dia, Workspace ~1500/dia.
- **Menors**: casella de consentiment obligatòria; el text LOPD és a la nota. Revisa que el text legal sigui el que vol el club.
```
