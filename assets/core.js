/* Pont Anki–Noji : moteur de conversion (lecture .apkg/.colpkg, CSV, écriture .apkg compatible). */
(function (root) {
  'use strict';

  const L = {}; // JSZip, SQL (sql.js initialisé), fzstd
  function setLibs(o) { Object.assign(L, o); }

  class PontError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  const td = new TextDecoder();
  const te = new TextEncoder();

  // ---------- petits outils ----------
  function isZstd(u8) {
    return u8 && u8.length >= 4 && u8[0] === 0x28 && u8[1] === 0xB5 && u8[2] === 0x2F && u8[3] === 0xFD;
  }
  function unz(u8) { return isZstd(u8) ? L.fzstd.decompress(u8) : u8; }

  // Lecteur protobuf minimal (varint + longueur délimitée)
  function pbRead(u8) {
    const out = [];
    let i = 0;
    function varint() {
      let x = 0, s = 0, b;
      do { b = u8[i++]; x += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80 && i < u8.length);
      return x;
    }
    while (i < u8.length) {
      const key = varint();
      const f = Math.floor(key / 8), wt = key % 8;
      if (wt === 0) out.push({ f, wt, v: varint() });
      else if (wt === 2) { const len = varint(); out.push({ f, wt, v: u8.subarray(i, i + len) }); i += len; }
      else if (wt === 1) i += 8;
      else if (wt === 5) i += 4;
      else break;
    }
    return out;
  }

  function parseMediaEntries(u8) {
    const entries = pbRead(u8).filter(x => x.f === 1 && x.wt === 2);
    return entries.map((e, idx) => {
      let name = '', zipName = String(idx);
      for (const x of pbRead(e.v)) {
        if (x.f === 1 && x.wt === 2) name = td.decode(x.v);
        if (x.f === 255 && x.wt === 0) zipName = String(x.v);
      }
      return { name, zipName };
    });
  }

  function q(db, sql, params) {
    const st = db.prepare(sql);
    if (params) st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.get());
    st.free();
    return rows;
  }

  const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const k = e.toLowerCase();
      if (k in ENT) return ENT[k];
      if (root.document) { const t = root.document.createElement('textarea'); t.innerHTML = m; return t.value; }
      return m;
    });
  }

  // HTML Anki -> texte lisible (garde les retours à la ligne)
  function htmlToText(html) {
    if (!html) return '';
    let s = String(html);
    s = s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
    s = s.replace(/\[sound:[^\]]*\]/g, '');
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h\d|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '• ');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    return s.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Texte brut -> HTML (pour les cartes venant d'un CSV sans balises)
  function textToHtml(t) {
    const s = String(t ?? '');
    if (/<\/?(b|i|u|br|div|p|span|img|sub|sup|ul|ol|li|strong|em)\b/i.test(s)) return s; // déjà du HTML
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
  }

  // Texte servant au tri / checksum (équivalent simplifié d'Anki)
  function stripForSort(html) {
    let s = String(html || '').replace(/<img[^>]*src=["']?([^"' >]+)[^>]*>/gi, ' $1 ');
    s = s.replace(/<[^>]+>/g, '');
    return decodeEntities(s).replace(/\u00a0/g, ' ').trim();
  }

  function mediaRefs(html) {
    const out = new Set();
    const s = String(html || '');
    let m;
    const reImg = /<(?:img|source|audio|video)\b[^>]*?src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((m = reImg.exec(s))) {
      const n = m[1] || m[2] || m[3];
      if (n && !/^(https?:|data:|blob:)/i.test(n)) out.add(decodeEntities(n));
    }
    const reSnd = /\[sound:([^\]]+)\]/g;
    while ((m = reSnd.exec(s))) out.add(m[1]);
    return [...out];
  }

  // SHA-1 (pour le checksum des notes)
  function sha1Hex(str) {
    const msg = te.encode(str);
    const ml = msg.length;
    const words = new Uint32Array((((ml + 8) >> 6) + 1) * 16);
    for (let i = 0; i < ml; i++) words[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
    words[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
    words[words.length - 1] = ml * 8;
    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80);
    for (let i = 0; i < words.length; i += 16) {
      for (let t = 0; t < 16; t++) w[t] = words[i + t];
      for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        let f, k;
        if (t < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (t < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map(x => x.toString(16).padStart(8, '0')).join('');
  }

  const GUID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  function newGuid() {
    let s = '';
    const r = new Uint8Array(10);
    (root.crypto || globalThis.crypto).getRandomValues(r);
    for (const x of r) s += GUID_CHARS[x % GUID_CHARS.length];
    return s;
  }

  function clozeOrds(text) {
    const set = new Set();
    const re = /\{\{c(\d+)::/g;
    let m;
    while ((m = re.exec(String(text || '')))) set.add(parseInt(m[1], 10) - 1);
    return [...set].filter(n => n >= 0).sort((a, b) => a - b);
  }

  // ---------- lecture d'un paquet Anki ----------
  async function readPackage(buf) {
    let zip;
    try { zip = await L.JSZip.loadAsync(buf); }
    catch (e) { throw new PontError('not_zip', "Ce fichier n'est pas un paquet Anki lisible (.apkg ou .colpkg)."); }

    let version = 0;
    const metaF = zip.file('meta');
    if (metaF) {
      const m = pbRead(await metaF.async('uint8array'));
      const v = m.find(x => x.f === 1 && x.wt === 0);
      version = v ? v.v : 0;
    }
    let dbBytes, format;
    if (zip.file('collection.anki21b')) { dbBytes = unz(await zip.file('collection.anki21b').async('uint8array')); format = 'récent'; }
    else if (zip.file('collection.anki21')) { dbBytes = await zip.file('collection.anki21').async('uint8array'); format = '2.1'; }
    else if (zip.file('collection.anki2')) { dbBytes = await zip.file('collection.anki2').async('uint8array'); format = 'ancien'; }
    else throw new PontError('not_anki', "Ce fichier ne contient pas de cartes Anki.");

    // table des médias
    let mediaList = [];
    const mf = zip.file('media');
    if (mf) {
      const raw = unz(await mf.async('uint8array'));
      if (raw.length && raw[0] === 0x7b) {
        const obj = JSON.parse(td.decode(raw));
        mediaList = Object.entries(obj).map(([k, v]) => ({ zipName: k, name: v }));
      } else if (raw.length) {
        mediaList = parseMediaEntries(raw);
      }
    }
    const mediaIndex = new Map(mediaList.map(m => [m.name, m.zipName]));

    const db = new L.SQL.Database(dbBytes);
    let result;
    try { result = readCollection(db); }
    finally { db.close(); }

    if (result.notes.length === 1 && /Please update to the latest Anki version/i.test(result.notes[0].front)) {
      throw new PontError('dummy', "Ce paquet ne contient qu'une carte « Please update to the latest Anki version ». Réexporte depuis Anki.");
    }

    result.format = format;
    result.version = version;
    result.media = {
      names: [...mediaIndex.keys()],
      has: (name) => mediaIndex.has(name),
      get: async (name) => {
        const z = mediaIndex.get(name);
        if (z == null) return null;
        const f = zip.file(z);
        if (!f) return null;
        return unz(await f.async('uint8array'));
      }
    };
    return result;
  }

  function readCollection(db) {
    const tables = new Set(q(db, "select name from sqlite_master where type='table'").map(r => r[0]));
    if (!tables.has('notes') || !tables.has('cards')) throw new PontError('not_anki', "Collection Anki illisible.");
    const colRow = q(db, 'select crt, models, decks, conf from col')[0] || [0, '{}', '{}', '{}'];
    const crt = colRow[0];
    let schedVer = 2;
    const models = {};
    const decks = {};
    if (tables.has('notetypes')) {
      for (const [id, name, config] of q(db, 'select id, name, config from notetypes')) {
        let kind = 0;
        if (config && config.length) {
          const k = pbRead(config).find(x => x.f === 1 && x.wt === 0);
          if (k) kind = k.v;
        }
        models[id] = { name: String(name), kind, fields: [] };
      }
      for (const [ntid, ord, name] of q(db, 'select ntid, ord, name from fields')) {
        if (models[ntid]) models[ntid].fields[ord] = String(name);
      }
      for (const [id, name] of q(db, 'select id, name from decks')) decks[id] = String(name).split('\x1f').join('::');
    } else {
      const m = JSON.parse(colRow[1] || '{}');
      for (const k in m) {
        const x = m[k];
        models[k] = { name: x.name, kind: x.type || 0, fields: (x.flds || []).slice().sort((a, b) => a.ord - b.ord).map(f => f.name) };
      }
      const d = JSON.parse(colRow[2] || '{}');
      for (const k in d) decks[k] = d[k].name;
      try { const c = JSON.parse(colRow[3] || '{}'); if (c.schedVer) schedVer = c.schedVer; } catch (e) { /* conf illisible : on garde 2 */ }
    }

    const cardsByNote = new Map();
    for (const r of q(db, 'select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags from cards order by nid, ord')) {
      const inFiltered = r[13] && r[13] !== 0;
      const c = {
        id: r[0], ord: r[3], did: inFiltered ? r[13] : r[2],
        type: r[4], queue: r[5], due: inFiltered && r[12] ? r[12] : r[6],
        ivl: r[7], factor: r[8], reps: r[9], lapses: r[10], left: r[11], flags: r[14]
      };
      if (!cardsByNote.has(r[1])) cardsByNote.set(r[1], []);
      cardsByNote.get(r[1]).push(c);
    }

    const notes = [];
    const skipped = { imageOcclusion: 0, empty: 0 };
    let withProgress = 0;
    for (const [id, guid, mid, tags, flds] of q(db, 'select id, guid, mid, tags, flds from notes')) {
      const model = models[mid] || { name: '?', kind: 0, fields: [] };
      const values = String(flds).split('\x1f');
      const cards = cardsByNote.get(id) || [];
      if (/image occlusion/i.test(model.name) || values.some(v => /\{\{c\d+::image-occlusion:/.test(v))) { skipped.imageOcclusion++; continue; }
      let kind = model.kind === 1 ? 'cloze' : 'basic';
      let front, back;
      if (kind === 'cloze') {
        const idx = Math.max(0, values.findIndex(v => /\{\{c\d+::/.test(v)));
        front = values[idx] || '';
        back = values.filter((v, i) => i !== idx && v.trim()).join('<br><br>');
        if (!clozeOrds(front).length) kind = 'basic';
      } else {
        front = values[0] || '';
        back = values.slice(1).filter(v => v.trim()).join('<br><br>');
      }
      if (!stripForSort(front) && !stripForSort(back) && !mediaRefs(front + back).length) { skipped.empty++; continue; }
      const deckId = cards.length ? cards[0].did : null;
      const deck = (deckId != null && decks[deckId]) || 'Importé';
      const sched = cards.filter(c => c.type !== 0 || c.queue < 0 || c.flags);
      if (sched.some(c => c.type !== 0)) withProgress++;
      notes.push({
        id, guid: String(guid), deck, kind, front, back,
        tags: String(tags || '').trim().split(/\s+/).filter(Boolean),
        cards: cards.map(c => ({ id: c.id, ord: c.ord, type: c.type, queue: c.queue, due: c.due, ivl: c.ivl, factor: c.factor, reps: c.reps, lapses: c.lapses, left: c.left, flags: c.flags })),
        modelName: model.name
      });
    }

    // historique de révision
    const revlog = new Map();
    if (tables.has('revlog')) {
      for (const r of q(db, 'select id, cid, ease, ivl, lastIvl, factor, time, type from revlog')) {
        if (!revlog.has(r[1])) revlog.set(r[1], []);
        revlog.get(r[1]).push(r);
      }
    }

    return { source: 'anki', crt, schedVer, notes, skipped, withProgress, revlog };
  }

  // ---------- CSV / texte ----------
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).slice(0, 20);
    const cands = ['\t', ';', ','];
    let best = ',', bestScore = -1;
    for (const d of cands) {
      const counts = lines.map(l => { let n = 0, inQ = false; for (const ch of l) { if (ch === '"') inQ = !inQ; else if (ch === d && !inQ) n++; } return n; });
      const withIt = counts.filter(n => n > 0).length;
      const score = withIt * 10 - (new Set(counts).size);
      if (withIt > 0 && score > bestScore) { best = d; bestScore = score; }
    }
    return best;
  }

  function parseDelimited(text, delim) {
    text = String(text).replace(/^\uFEFF/, '');
    // en-têtes Anki (#separator:tab, #html:true…)
    const meta = {};
    while (/^#[a-z ]+:/i.test(text)) {
      const nl = text.indexOf('\n');
      const line = (nl < 0 ? text : text.slice(0, nl)).trim();
      const m = line.match(/^#([a-z ]+):(.*)$/i);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    if (!delim) {
      const sep = (meta.separator || '').toLowerCase();
      delim = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' }[sep] || (sep.length === 1 ? sep : detectDelimiter(text));
    }
    const rows = [];
    let row = [], cell = '', inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
        cell += ch; i++; continue;
      }
      if (ch === '"' && cell === '') { inQ = true; i++; continue; }
      if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { rows: rows.filter(r => r.some(c => c.trim() !== '')), delim, meta };
  }

  const HEAD = {
    front: ['front', 'front side', 'front_side', 'recto', 'question', 'term', 'terme', 'word', 'mot', 'avant', 'face avant', 'card front', 'frente', 'vorderseite', 'text', 'texte', 'q'],
    back: ['back', 'back side', 'back_side', 'verso', 'answer', 'réponse', 'reponse', 'definition', 'définition', 'arrière', 'face arrière', 'card back', 'reverso', 'rückseite', 'back extra', 'a'],
    tags: ['tags', 'tag', 'étiquettes', 'etiquettes', 'labels'],
    deck: ['deck', 'paquet', 'deck name', 'subdeck']
  };
  function guessMapping(rows) {
    const first = (rows[0] || []).map(c => c.trim().toLowerCase());
    const find = (keys) => first.findIndex(c => keys.includes(c));
    const f = find(HEAD.front), b = find(HEAD.back);
    const hasHeader = f >= 0 || b >= 0;
    return {
      hasHeader,
      front: f >= 0 ? f : 0,
      back: b >= 0 ? b : (f === 1 ? 0 : 1),
      tags: find(HEAD.tags),
      deck: find(HEAD.deck),
      columns: Math.max(...rows.slice(0, 50).map(r => r.length), 0),
      header: hasHeader ? rows[0] : null
    };
  }

  function notesFromRows(rows, mapping, deckName) {
    const out = [];
    const start = mapping.hasHeader ? 1 : 0;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const front = textToHtml((r[mapping.front] ?? '').trim());
      const back = textToHtml((r[mapping.back] ?? '').trim());
      if (!stripForSort(front) && !stripForSort(back)) continue;
      const kind = clozeOrds(front).length ? 'cloze' : 'basic';
      const tags = mapping.tags >= 0 ? String(r[mapping.tags] || '').split(/[\s,;]+/).filter(Boolean) : [];
      const deck = mapping.deck >= 0 && r[mapping.deck] ? String(r[mapping.deck]).trim() : deckName;
      out.push({ id: null, guid: null, deck, kind, front, back, tags, cards: null });
    }
    return out;
  }

  // ---------- écriture ----------
  function csvCell(s) {
    s = String(s ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(notes) {
    return notes.map(n => csvCell(htmlToText(n.front)) + ',' + csvCell(htmlToText(n.back))).join('\r\n') + '\r\n';
  }
  function toPasteText(notes) {
    const flat = (s) => htmlToText(s).replace(/\t/g, ' ').replace(/\s*\n+\s*/g, ' / ').trim();
    return notes.map(n => flat(n.front) + '\t' + flat(n.back)).join('\n');
  }

  const BASIC_MID = 1727400000001;
  const CLOZE_MID = 1727400000002;
  const CSS = '.card {\n  font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;\n  font-size: 22px;\n  line-height: 1.4;\n  text-align: center;\n  color: black;\n  background-color: white;\n}\nimg { max-width: 100%; }\n';
  const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';

  function fld(name, ord) { return { name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] }; }
  function modelsJson(nowSec, did) {
    const base = { mod: nowSec, usn: -1, sortf: 0, did, latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false, tags: [], vers: [] };
    return {
      [BASIC_MID]: Object.assign({}, base, {
        id: BASIC_MID, name: 'Basique (Pont)', type: 0, css: CSS,
        flds: [fld('Front', 0), fld('Back', 1)],
        tmpls: [{ name: 'Carte 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}', did: null, bqfmt: '', bafmt: '' }],
        req: [[0, 'any', [0]]]
      }),
      [CLOZE_MID]: Object.assign({}, base, {
        id: CLOZE_MID, name: 'Texte à trous (Pont)', type: 1,
        css: CSS + '.cloze {\n  font-weight: bold;\n  color: #2446a8;\n}\n.nightMode .cloze {\n  color: #9db4ff;\n}\n',
        flds: [fld('Text', 0), fld('Back Extra', 1)],
        tmpls: [{ name: 'Texte à trous', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}', did: null, bqfmt: '', bafmt: '' }]
      })
    };
  }
  function deckJson(id, name, nowSec) {
    return { id, name, mod: nowSec, usn: -1, collapsed: false, browserCollapsed: false, conf: 1, desc: '', dyn: 0,
      extendNew: 10, extendRev: 50, newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0] };
  }
  const DCONF = { 1: { id: 1, mod: 0, name: 'Default', usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
    rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200 } } };

  const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);`;

  /**
   * Construit un .apkg « ancien format » (collection.anki2 unique), lisible par Anki (toutes versions) et par Noji.
   * opts: { notes, withProgress, crt, schedVer, revlog, getMedia(name)->Uint8Array|null, defaultDeck }
   * Retourne { bytes: Uint8Array, notes: n, cards: n, media: n, missingMedia: [] }
   */
  async function buildApkg(opts) {
    const notes = opts.notes || [];
    if (!notes.length) throw new PontError('empty', 'Aucune carte à exporter.');
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const withProgress = !!opts.withProgress;
    const crt = withProgress && opts.crt ? opts.crt : (() => { const d = new Date(); d.setHours(4, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();

    // paquets (avec parents)
    const deckNames = new Set();
    for (const n of notes) {
      const name = (n.deck || opts.defaultDeck || 'Importé').trim() || 'Importé';
      const parts = name.split('::').map(p => p.trim()).filter(Boolean);
      for (let i = 1; i <= parts.length; i++) deckNames.add(parts.slice(0, i).join('::'));
    }
    const deckIds = new Map();
    let did = nowMs;
    for (const name of [...deckNames].sort()) deckIds.set(name, did++);
    const decks = { 1: deckJson(1, 'Default', nowSec) };
    for (const [name, id] of deckIds) decks[id] = deckJson(id, name, nowSec);
    const firstDeck = deckIds.values().next().value;

    const db = new L.SQL.Database();
    try {
      db.exec(SCHEMA);
      const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true,
        curModel: null, nextPos: notes.length + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true, schedVer: withProgress ? (opts.schedVer || 2) : 2 };
      db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)',
        [crt, nowMs, nowMs, JSON.stringify(conf), JSON.stringify(modelsJson(nowSec, firstDeck)), JSON.stringify(decks), JSON.stringify(DCONF), '{}']);

      const insNote = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      const insCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const insRev = db.prepare('INSERT OR IGNORE INTO revlog VALUES (?,?,?,?,?,?,?,?,?)');
      const usedNoteIds = new Set(), usedCardIds = new Set();
      let nextId = nowMs * 10; // identifiants générés : hors de portée des ids Anki existants
      const freshId = (used) => { while (used.has(nextId)) nextId++; used.add(nextId); return nextId++; };
      let pos = 0, cardCount = 0;
      const media = new Set();

      for (const n of notes) {
        let kind = n.kind === 'cloze' && clozeOrds(n.front).length ? 'cloze' : 'basic';
        const mid = kind === 'cloze' ? CLOZE_MID : BASIC_MID;
        let nid = n.id != null && !usedNoteIds.has(n.id) ? n.id : null;
        if (nid == null) nid = freshId(usedNoteIds); else usedNoteIds.add(nid);
        const guid = n.guid || newGuid();
        const front = n.front || '', back = n.back || '';
        const sfld = stripForSort(front);
        const csum = parseInt(sha1Hex(sfld).slice(0, 8), 16);
        const tags = n.tags && n.tags.length ? ' ' + n.tags.map(t => String(t).replace(/\s+/g, '_')).join(' ') + ' ' : '';
        insNote.run([nid, guid, mid, nowSec, -1, tags, front + '\x1f' + back, sfld, csum, 0, '']);
        for (const m of mediaRefs(front + ' ' + back)) media.add(m);

        const deckId = deckIds.get((n.deck || opts.defaultDeck || 'Importé').split('::').map(p => p.trim()).filter(Boolean).join('::')) || firstDeck;
        const ords = kind === 'cloze' ? clozeOrds(front) : [0];
        const src = withProgress && Array.isArray(n.cards) ? n.cards : [];
        for (let k = 0; k < ords.length; k++) {
          const ord = ords[k];
          // carte source correspondante : même ord pour un texte à trous, la première pour une carte simple
          const s = kind === 'cloze' ? src.find(c => c.ord === ord) : src.slice().sort((a, b) => a.ord - b.ord)[0];
          pos++;
          let cid = s && s.id != null && !usedCardIds.has(s.id) ? s.id : null;
          if (cid == null) cid = freshId(usedCardIds); else usedCardIds.add(cid);
          if (s && (s.type !== 0 || s.queue < 0)) {
            insCard.run([cid, nid, deckId, ord, nowSec, -1, s.type, s.queue, s.type === 0 ? pos : s.due, s.ivl, s.factor, s.reps, s.lapses, s.left, 0, 0, s.flags || 0, '']);
            const revs = opts.revlog && s.id != null ? opts.revlog.get(s.id) : null;
            if (revs) for (const r of revs) insRev.run([r[0], cid, -1, r[2], r[3], r[4], r[5], r[6], r[7]]);
          } else {
            insCard.run([cid, nid, deckId, ord, nowSec, -1, 0, 0, pos, 0, 0, 0, 0, 0, 0, 0, 0, '']);
          }
          cardCount++;
        }
      }
      insNote.free(); insCard.free(); insRev.free();
      const dbBytes = db.export();

      const zip = new L.JSZip();
      zip.file('collection.anki2', dbBytes);
      const mediaMap = {};
      const missing = [];
      let i = 0;
      if (opts.getMedia) {
        for (const name of media) {
          const data = await opts.getMedia(name);
          if (!data) { missing.push(name); continue; }
          zip.file(String(i), data);
          mediaMap[i] = name;
          i++;
        }
      }
      zip.file('media', JSON.stringify(mediaMap));
      const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      return { bytes, notes: notes.length, cards: cardCount, media: i, missingMedia: missing };
    } finally {
      db.close();
    }
  }

  // ---------- lecture d'un export Noji (.ofc) ----------
  // Structure observée : zip { deck_export_data (JSON compressé zstd) | deck_data.json, attachments.zip }
  // JSON : [ { id, name, ancestry: "/parentId/", notes: [ { fields: { front_side, back_side }, note_attachments: [ { field_name, attachment: { media_file: { url } } } ] } ] } ]
  async function readOfc(buf) {
    let zip;
    try { zip = await L.JSZip.loadAsync(buf); }
    catch (e) { throw new PontError('not_zip', "Ce fichier n'est pas un export Noji lisible (.ofc)."); }
    const find = (re) => Object.keys(zip.files).find(p => re.test(p) && !zip.files[p].dir);
    let jsonText = null;
    const dataPath = find(/(^|\/)deck_export_data$/);
    const jsonPath = find(/(^|\/)deck_data\.json$/);
    if (jsonPath) jsonText = await zip.file(jsonPath).async('string');
    else if (dataPath) {
      const raw = await zip.file(dataPath).async('uint8array');
      jsonText = td.decode(unz(raw));
    } else throw new PontError('not_noji', "Ce fichier ne ressemble pas à un export Noji : il n'y a pas de données de paquet dedans.");
    let data;
    try { data = JSON.parse(jsonText); } catch (e) { throw new PontError('not_noji', "Les données du paquet Noji sont illisibles."); }
    const decksArr = Array.isArray(data) ? data : (Array.isArray(data.decks) ? data.decks : [data]);

    // médias : attachments.zip (ou fichiers en vrac)
    const mediaFiles = new Map(); // basename -> async () => Uint8Array
    const attPath = find(/(^|\/)attachments\.zip$/);
    if (attPath) {
      try {
        const inner = await L.JSZip.loadAsync(await zip.file(attPath).async('uint8array'));
        for (const p of Object.keys(inner.files)) {
          if (inner.files[p].dir) continue;
          const base = p.split('/').pop();
          mediaFiles.set(base, () => inner.file(p).async('uint8array'));
          mediaFiles.set(decodeURIComponent(base), () => inner.file(p).async('uint8array'));
        }
      } catch (e) { /* pièces jointes illisibles : on continue sans */ }
    }
    for (const p of Object.keys(zip.files)) {
      if (zip.files[p].dir || p === attPath || p === dataPath || p === jsonPath) continue;
      const base = p.split('/').pop();
      if (!mediaFiles.has(base)) mediaFiles.set(base, () => zip.file(p).async('uint8array'));
    }

    const byId = new Map();
    for (const d of decksArr) if (d && d.id != null) byId.set(String(d.id), d);
    const fullName = (d) => {
      const parts = String(d.ancestry || '').split('/').filter(Boolean).map(id => byId.get(String(id))).filter(Boolean).map(x => String(x.name || '').trim()).filter(Boolean);
      parts.push(String(d.name || 'Paquet Noji').trim() || 'Paquet Noji');
      return parts.join('::');
    };
    const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? (v.text || v.html || v.value || '') : String(v));
    const attName = (a) => {
      const url = a?.attachment?.media_file?.url || a?.attachment?.url || a?.media_file?.url || a?.url || '';
      const base = String(url).split('?')[0].split('#')[0].split('/').pop();
      return base ? decodeURIComponent(base) : '';
    };
    const notes = [];
    for (const d of decksArr) {
      if (!d || !Array.isArray(d.notes)) continue;
      const deck = fullName(d);
      for (const n of d.notes) {
        const f = n.fields || n;
        let front = textToHtml(str(f.front_side ?? f.front ?? f.question ?? f.text ?? ''));
        let back = textToHtml(str(f.back_side ?? f.back ?? f.answer ?? f.back_extra ?? ''));
        for (const a of n.note_attachments || n.attachments || []) {
          const name = attName(a);
          if (!name) continue;
          const tag = `<br><img src="${name.replace(/"/g, '')}">`;
          if ((a.field_name || '') === 'front_side') front += tag; else back += tag;
        }
        if (!stripForSort(front) && !stripForSort(back) && !mediaRefs(front + back).length) continue;
        const kind = clozeOrds(front).length ? 'cloze' : 'basic';
        const tags = Array.isArray(n.tags) ? n.tags.map(t => str(t.name ?? t)).filter(Boolean) : [];
        notes.push({ id: null, guid: null, deck, kind, front, back, tags, cards: null });
      }
    }
    if (!notes.length) throw new PontError('empty', "Cet export Noji ne contient aucune fiche.");
    return {
      source: 'noji', notes,
      media: {
        names: [...mediaFiles.keys()],
        has: (name) => mediaFiles.has(name),
        get: async (name) => { const g = mediaFiles.get(name) || mediaFiles.get(decodeURIComponent(name)); return g ? g() : null; }
      }
    };
  }

  // Met un fichier dans un .zip (utile quand l'hôte n'autorise pas l'extension .apkg au téléchargement)
  async function wrapInZip(filename, bytes) {
    const zip = new L.JSZip();
    zip.file(filename, bytes);
    return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  }

  // Lecture tolérante d'une réponse d'IA collée : JSON (même dans un bloc ```), sinon lignes "recto<TAB>verso" / "recto | verso"
  function parseAIReply(text) {
    let t = String(text || '').trim();
    if (!t) return [];
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fence ? fence[1] : null, t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1), t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)].filter(Boolean);
    for (const c of candidates) {
      try {
        const v = JSON.parse(c);
        const list = Array.isArray(v) ? v : Array.isArray(v.cards) ? v.cards : Array.isArray(v.fiches) ? v.fiches : null;
        if (list) return list;
      } catch (e) { /* on essaie le candidat suivant */ }
    }
    const rows = [];
    for (const line of t.split(/\r?\n/)) {
      const l = line.trim().replace(/^[-*•]\s*/, '');
      if (!l) continue;
      const m = l.split(/\t| \| |;;/);
      if (m.length >= 2) rows.push({ type: /\{\{c\d+::/.test(m[0]) ? 'cloze' : 'basic', front: m[0].trim(), back: m.slice(1).join(' ').trim() });
      else if (/\{\{c\d+::/.test(l)) rows.push({ type: 'cloze', front: l, back: '' });
    }
    return rows;
  }

  root.PontCore = {
    setLibs, PontError, readPackage, readOfc, parseAIReply, parseDelimited, guessMapping, notesFromRows, buildApkg, wrapInZip,
    toCSV, toPasteText, htmlToText, textToHtml, stripForSort, mediaRefs, clozeOrds, sha1Hex, detectDelimiter
  };
})(typeof window !== 'undefined' ? window : globalThis);
