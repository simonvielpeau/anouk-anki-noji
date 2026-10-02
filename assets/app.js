/* Pont — interface. */
(function () {
  'use strict';
  const VERSION = '1.0 · octobre 2026';
  const P = window.PontCore;
  const AI = window.PontAI;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => new Intl.NumberFormat('fr-FR').format(n);
  const plural = (n, one, many) => `${fmt(n)} ${n > 1 ? many : one}`;
  const uiErr = (m) => Object.assign(new Error(m), { ui: true });
  const errText = (e) => (e && (e.ui || (e instanceof P.PontError)) ? e.message : "Une erreur inattendue s'est produite. Réessaie, ou essaie un autre fichier.");
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pont.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pont.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
    del(k) { try { localStorage.removeItem('pont.' + k); } catch (e) { /* idem */ } }
  };
  $('#version').textContent = VERSION;

  // ---------- appareil ----------
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const canShareFiles = (() => {
    try {
      if (!navigator.share || !navigator.canShare || typeof File !== 'function') return false;
      return navigator.canShare({ files: [new File([new Uint8Array([80, 75])], 'test.apkg', { type: 'application/octet-stream' })] });
    } catch (e) { return false; }
  })();

  // ---------- bibliothèques ----------
  let corePromise = null;
  function ensureCore() {
    if (!corePromise) {
      corePromise = (async () => {
        const SQL = await window.initSqlJs({ locateFile: (f) => 'vendor/' + f });
        P.setLibs({ JSZip: window.JSZip, SQL, fzstd: window.fzstd });
      })().catch(e => { corePromise = null; throw uiErr("Un composant de la page ne s'est pas chargé. Recharge la page puis réessaie."); });
    }
    return corePromise;
  }
  setTimeout(() => { ensureCore().catch(() => {}); }, 600);
  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => res();
        s.onerror = () => { scripts.delete(src); s.remove(); rej(uiErr('Un composant de la page ne se charge pas. Vérifie la connexion puis réessaie.')); };
        document.head.appendChild(s);
      }));
    }
    return scripts.get(src);
  }

  // ---------- état ----------
  let uid = 1;
  const prep = (n) => { n._uid = uid++; return n; };
  const S = {
    flow: null,
    source: { kind: 'none' },
    notes: [], excluded: new Set(), deckName: '', shown: 24, filter: '', keepProgress: true,
    csv: null, course: null, aiCtl: null, lastRemoved: null,
    built: null, buildVersion: 0, buildTimer: null
  };
  const settings = { key: store.get('key', ''), model: store.get('model', null), provider: store.get('provider', null) };

  // ---------- messages ----------
  function say(id, html, kind) { const el = $('#' + id); el.className = 'msg' + (kind ? ' ' + kind : ''); el.innerHTML = html || ''; }

  // ---------- écrans ----------
  const TITLES = {
    anki2noji: 'Anki <span class="arrow">→</span> Noji',
    noji2anki: 'Noji <span class="arrow">→</span> Anki',
    cours: 'Cours <span class="arrow">→</span> fiches'
  };
  function showHome() {
    $('#screen-home').hidden = false; $('#screen-flow').hidden = true; $('#btn-back').hidden = true;
    window.scrollTo({ top: 0 });
  }
  function openFlow(flow) {
    S.flow = flow;
    $('#flow-title').innerHTML = TITLES[flow];
    $$('.panel[data-flow]').forEach(p => { p.hidden = p.dataset.flow !== flow; });
    const lead = flow === 'noji2anki' || flow === 'cours' ? 'anki' : 'noji';
    $('#dest-anki').classList.toggle('lead', lead === 'anki');
    $('#dest-noji').classList.toggle('lead', lead === 'noji');
    $('#screen-home').hidden = true; $('#screen-flow').hidden = false; $('#btn-back').hidden = false;
    renderAIMode();
    renderAll();
    window.scrollTo({ top: 0 });
  }
  function resetFlow() {
    revokeMedia();
    S.source = { kind: 'none' }; S.notes = []; S.excluded = new Set(); S.deckName = ''; S.shown = 24; S.filter = ''; S.csv = null; S.course = null; S.built = null;
    $('#filter').value = ''; $('#mapping').hidden = true; $('#paste-noji').value = ''; $('#cours-text').value = ''; $('#ai-reply').value = ''; $('#ai-hint').value = '';
    say('msg-src', ''); say('msg-prev', '');
    updatePromptButton();
    renderAll();
  }
  $$('.tile').forEach(t => t.addEventListener('click', () => { if (S.flow !== t.dataset.flow) { resetFlow(); } openFlow(t.dataset.flow); }));
  $('#btn-back').addEventListener('click', showHome);
  $('#brand').addEventListener('click', showHome);
  $('#btn-restart').addEventListener('click', () => { resetFlow(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  // ---------- fichiers ----------
  const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
  const baseName = (name) => String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim();
  function bindDrop(zoneId, inputId, handler) {
    const zone = $('#' + zoneId), input = $('#' + inputId);
    input.addEventListener('change', () => { if (input.files && input.files.length) handler([...input.files]); input.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, () => zone.classList.remove('over')));
    zone.addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])]; if (f.length) handler(f); });
  }
  const mediaMime = (name) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic' }[extOf(name)] || 'application/octet-stream');
  const blobUrls = new Map();
  function revokeMedia() { for (const p of blobUrls.values()) p.then(u => u && URL.revokeObjectURL(u)); blobUrls.clear(); }
  function mediaUrl(name) {
    if (blobUrls.has(name)) return blobUrls.get(name);
    const get = S.source.media ? S.source.media.get : null;
    const p = get ? get(name).then(b => (b ? URL.createObjectURL(new Blob([b], { type: mediaMime(name) })) : null)).catch(() => null) : Promise.resolve(null);
    blobUrls.set(name, p);
    return p;
  }
  function loadNotes(source, notes, deckName) {
    revokeMedia();
    S.source = source; S.notes = notes.map(prep); S.excluded = new Set(); S.shown = 24; S.filter = ''; S.keepProgress = true; S.built = null;
    $('#filter').value = '';
    if (deckName != null) S.deckName = deckName;
    renderAll(true);
  }

  // ----- Anki -----
  async function onAnkiFiles(files) {
    const f = files[0];
    const ext = extOf(f.name);
    if (S.flow === 'anki2noji' && (['csv', 'tsv', 'txt', 'ofc'].includes(ext))) { say('msg-src', "Ce fichier vient de Noji : utilise plutôt « Noji → Anki » depuis l'accueil.", 'warn'); return; }
    say('msg-src', `Lecture de « ${esc(f.name)} »…`, 'pulse');
    try {
      await ensureCore();
      const pkg = await P.readPackage(await f.arrayBuffer());
      const decks = new Set(pkg.notes.map(n => n.deck)).size;
      loadNotes({ kind: 'anki', pkg, media: pkg.media, fileName: f.name }, pkg.notes, null);
      let extra = pkg.skipped.imageOcclusion ? ` ${plural(pkg.skipped.imageOcclusion, "fiche à masquage d'image ignorée", "fiches à masquage d'image ignorées")}.` : '';
      if (!pkg.notes.length) say('msg-src', 'Ce paquet ne contient aucune fiche convertible.' + extra, 'warn');
      else say('msg-src', `<b>${plural(pkg.notes.length, 'fiche trouvée', 'fiches trouvées')}</b> dans ${plural(decks, 'paquet', 'paquets')}. Vérifie-les, puis envoie-les à l'étape 3.${extra}`, 'ok');
    } catch (e) {
      const known = e && (e.ui || e instanceof P.PontError);
      say('msg-src', known ? esc(e.message) : "Impossible de lire ce paquet. Vérifie qu'il s'agit bien d'un export Anki (.apkg ou .colpkg).", 'err');
      console.error(e);
    }
  }
  bindDrop('drop-anki', 'file-anki', onAnkiFiles);

  // ----- Noji -----
  function applyCsv() {
    const { parsed, mapping, name } = S.csv;
    const notes = P.notesFromRows(parsed.rows, mapping, '').map(n => Object.assign(n, { ownDeck: n.deck || '', deck: '' }));
    loadNotes({ kind: 'csv', fileName: name }, notes, S.deckName || baseName(name) || 'Mes fiches');
    return notes.length;
  }
  function renderMapping() {
    const { parsed, mapping } = S.csv;
    const show = mapping.columns > 2 || !mapping.hasHeader;
    $('#mapping').hidden = !show;
    if (!show) return;
    const first = parsed.rows[0] || [];
    const label = (i) => `Colonne ${i + 1}${first[i] ? ' — ' + String(first[i]).slice(0, 28) : ''}`;
    for (const [id, key] of [['map-front', 'front'], ['map-back', 'back']]) {
      const sel = $('#' + id);
      sel.innerHTML = Array.from({ length: mapping.columns }, (_, i) => `<option value="${i}">${esc(label(i))}</option>`).join('');
      sel.value = String(mapping[key]);
    }
    $('#map-header').checked = mapping.hasHeader;
  }
  function loadCsvText(text, name) {
    const parsed = P.parseDelimited(text);
    if (!parsed.rows.length) throw uiErr('Ce fichier est vide.');
    const mapping = P.guessMapping(parsed.rows);
    if (mapping.columns < 2) throw uiErr("Je ne trouve qu'une colonne. Il faut un recto et un verso séparés par une virgule, un point-virgule ou une tabulation.");
    S.csv = { parsed, mapping, name };
    S.deckName = baseName(name) || 'Mes fiches';
    const n = applyCsv();
    renderMapping();
    say('msg-src', n ? `<b>${plural(n, 'fiche trouvée', 'fiches trouvées')}</b>.${$('#mapping').hidden ? '' : ' Si recto et verso sont inversés, change les colonnes ci-dessous.'}` : 'Aucune fiche trouvée : vérifie les colonnes ci-dessous.', n ? 'ok' : 'warn');
  }
  async function onNojiFiles(files) {
    const f = files[0];
    const ext = extOf(f.name);
    if (['apkg', 'colpkg'].includes(ext)) { say('msg-src', "Ce fichier vient d'Anki : utilise plutôt « Anki → Noji » depuis l'accueil.", 'warn'); return; }
    say('msg-src', `Lecture de « ${esc(f.name)} »…`, 'pulse');
    try {
      $('#mapping').hidden = true; S.csv = null;
      const buf = await f.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 2));
      if (ext === 'ofc' || (head[0] === 0x50 && head[1] === 0x4b)) {
        await ensureCore();
        const pkg = await P.readOfc(buf);
        const decks = new Set(pkg.notes.map(n => n.deck)).size;
        const media = new Set(); for (const n of pkg.notes) for (const m of P.mediaRefs(n.front + n.back)) media.add(m);
        loadNotes({ kind: 'noji', media: pkg.media, fileName: f.name }, pkg.notes, baseName(f.name));
        say('msg-src', `<b>${plural(pkg.notes.length, 'fiche trouvée', 'fiches trouvées')}</b> dans ${plural(decks, 'paquet', 'paquets')}${media.size ? `, avec ${plural(media.size, 'image', 'images')}` : ''}. Vérifie-les, puis envoie-les vers Anki.`, 'ok');
      } else {
        loadCsvText(new TextDecoder('utf-8').decode(buf), f.name);
      }
    } catch (e) {
      const known = e && (e.ui || e instanceof P.PontError);
      say('msg-src', known ? esc(e.message) : "Impossible de lire ce fichier. Il faut l'export de Noji (.ofc ou .csv).", 'err');
      console.error(e);
    }
  }
  bindDrop('drop-noji', 'file-noji', onNojiFiles);
  $('#btn-paste-noji').addEventListener('click', () => {
    const t = $('#paste-noji').value;
    if (!t.trim()) { say('msg-src', "Colle d'abord tes fiches dans le champ.", 'warn'); return; }
    try { loadCsvText(t, 'Fiches collées'); } catch (e) { say('msg-src', errText(e), 'err'); }
  });
  function remap() {
    if (!S.csv) return;
    S.csv.mapping.front = +$('#map-front').value; S.csv.mapping.back = +$('#map-back').value; S.csv.mapping.hasHeader = $('#map-header').checked;
    const n = applyCsv();
    say('msg-src', `<b>${plural(n, 'fiche', 'fiches')}</b> avec ces colonnes.`, n ? 'ok' : 'warn');
  }
  ['map-front', 'map-back', 'map-header'].forEach(id => $('#' + id).addEventListener('change', remap));

  // ----- Cours -----
  const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
  async function pdfLib() {
    await loadScript('vendor/pdf.min.js');
    const lib = window.pdfjsLib;
    if (!lib) throw uiErr('Le lecteur PDF ne se charge pas. Recharge la page.');
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    return lib;
  }
  async function readPdf(file) {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, disableFontFace: true }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let t = '';
      for (const it of tc.items) { t += it.str; t += it.hasEOL ? '\n' : (it.str && !/\s$/.test(it.str) ? ' ' : ''); }
      text += `\n\n[Page ${i}]\n` + t.replace(/[ \t]+/g, ' ').trim();
      page.cleanup();
    }
    const chars = text.replace(/\[Page \d+\]|\s/g, '').length;
    return { text, pages: doc.numPages, scanned: chars / Math.max(1, doc.numPages) < 60, doc };
  }
  async function pdfPagesAsImages(doc, max) {
    const out = [];
    for (let i = 1; i <= Math.min(doc.numPages, max); i++) {
      const page = await doc.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(v1.width, v1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      out.push(await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)));
      page.cleanup();
    }
    return out.filter(Boolean);
  }
  async function readDocx(file) {
    await loadScript('vendor/mammoth.browser.min.js');
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return r.value || '';
  }
  async function readPptx(file) {
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const num = (p) => +(/(\d+)\.xml$/.exec(p) || [0, 0])[1];
    const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
    let out = '';
    for (let i = 0; i < slides.length; i++) {
      const xml = await zip.file(slides[i]).async('string');
      const paras = xml.split(/<\/a:p>/).map(seg => [...seg.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map(m => m[1]).join('')).filter(s => s.trim());
      if (paras.length) out += `\n\n[Diapo ${i + 1}]\n` + decodeXml(paras.join('\n'));
    }
    return { text: out, slides: slides.length };
  }
  async function toJpeg(file, maxSide) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
      if (!b) throw new Error('toBlob');
      return b;
    } catch (e) { throw uiErr(`Impossible de lire l'image « ${file.name} ». Essaie une photo au format JPEG ou PNG.`); }
    finally { URL.revokeObjectURL(url); }
  }

  async function onCourseFiles(files) {
    const first = files[0];
    say('msg-src', `Lecture de ${files.length > 1 ? plural(files.length, 'fichier', 'fichiers') : '« ' + esc(first.name) + ' »'}…`, 'pulse');
    const course = { name: baseName(first.name) || 'Cours', text: '', images: [], pdfs: [], parts: [] };
    try {
      for (const f of files) {
        const ext = extOf(f.name);
        if (/^image\//.test(f.type) || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'].includes(ext)) {
          course.images.push(f); course.parts.push(f.name);
        } else if (ext === 'pdf' || f.type === 'application/pdf') {
          const r = await readPdf(f);
          course.pdfs.push({ file: f, pages: r.pages, scanned: r.scanned, text: r.scanned ? '' : r.text, doc: r.doc });
          course.parts.push(`${f.name} (${plural(r.pages, 'page', 'pages')}${r.scanned ? ', scanné' : ''})`);
        } else if (ext === 'docx') {
          course.text += `\n\n# ${f.name}\n` + await readDocx(f); course.parts.push(f.name);
        } else if (ext === 'pptx') {
          const r = await readPptx(f); course.text += `\n\n# ${f.name}\n` + r.text; course.parts.push(`${f.name} (${plural(r.slides, 'diapo', 'diapos')})`);
        } else if (['txt', 'md', 'markdown', 'csv', 'tsv', 'rtf'].includes(ext) || /^text\//.test(f.type)) {
          course.text += `\n\n# ${f.name}\n` + await f.text(); course.parts.push(f.name);
        } else if (['html', 'htm'].includes(ext)) {
          course.text += `\n\n# ${f.name}\n` + P.htmlToText(await f.text()); course.parts.push(f.name);
        } else if (['doc', 'ppt', 'odt', 'odp', 'pages', 'key'].includes(ext)) {
          throw uiErr(`« ${f.name} » : ce format n'est pas lu directement. Enregistre-le en PDF (Partager → Imprimer → PDF, ou Exporter en PDF), puis réessaie.`);
        } else if (['apkg', 'colpkg', 'ofc'].includes(ext)) {
          throw uiErr(`« ${f.name} » est un paquet de fiches, pas un cours. Pour le convertir, choisis « Anki → Noji » ou « Noji → Anki » depuis l'accueil.`);
        } else {
          throw uiErr(`« ${f.name} » : format non pris en charge. Utilise un PDF, un Word (.docx), un PowerPoint (.pptx), du texte ou des photos.`);
        }
      }
      const words = AI.countWords(course.text) + course.pdfs.reduce((a, p) => a + AI.countWords(p.text), 0);
      const scannedPages = course.pdfs.filter(p => p.scanned).reduce((a, p) => a + p.pages, 0);
      if (!words && !course.images.length && !scannedPages) throw uiErr("Je n'ai trouvé aucun texte dans ce fichier.");
      S.course = course;
      const bits = [];
      if (words) bits.push(`≈ ${fmt(words)} mots`);
      if (course.images.length) bits.push(plural(course.images.length, 'photo', 'photos'));
      if (scannedPages) bits.push(plural(scannedPages, 'page scannée', 'pages scannées'));
      say('msg-src', `<b>Cours chargé</b> : ${esc(course.parts.join(', '))} · ${esc(bits.join(' · '))}.`, 'ok');
      updatePromptButton();
    } catch (e) { S.course = null; say('msg-src', errText(e), 'err'); console.error(e); updatePromptButton(); }
  }
  bindDrop('drop-cours', 'file-cours', onCourseFiles);
  $('#cours-text').addEventListener('input', updatePromptButton);

  function courseTitle() { const t = (S.course ? S.course.name : ($('#cours-text').value.trim().split(/\n/)[0] || 'Cours')).slice(0, 60).trim(); return t.charAt(0).toUpperCase() + t.slice(1); }
  function courseText() {
    const c = S.course;
    const parts = [];
    if (c) { if (c.text.trim()) parts.push(c.text.trim()); for (const p of c.pdfs) if (p.text) parts.push(`# ${p.file.name}\n` + p.text.trim()); }
    const pasted = $('#cours-text').value.trim();
    if (pasted) parts.push(pasted);
    return parts.join('\n\n');
  }
  function aiOptions() {
    return { type: $('input[name="ai-type"]:checked').value, qty: $('input[name="ai-qty"]:checked').value, hint: $('#ai-hint').value.trim().slice(0, 300) };
  }
  function hasCourse() { return !!(S.course || $('#cours-text').value.trim().length > 40); }
  function updatePromptButton() {
    $('#btn-copy-prompt').disabled = !hasCourse();
    $('#btn-ai').disabled = !!S.aiCtl || !hasCourse() || !settings.key;
    const c = S.course;
    const attach = c && (c.images.length || c.pdfs.some(p => p.scanned));
    $('#prompt-note').textContent = !hasCourse() ? 'Choisis ou colle d\'abord ton cours.' : attach ? "Ton cours contient des photos ou un PDF scanné : joins aussi ce fichier dans la conversation avec l'IA, la consigne le précise." : '';
  }
  function renderAIMode() {
    const has = !!settings.key;
    $('#ai-key-mode').hidden = !has;
    $('#ai-paste-mode').hidden = has;
    $('#ai-model-note').textContent = has && settings.model ? `avec ${settings.model.label}` : '';
    updatePromptButton();
  }

  // Mode sans clé : copier la consigne, coller la réponse
  function copyText(text, onOk, onFail) {
    try { navigator.clipboard.writeText(text).then(onOk, onFail); } catch (e) { onFail(); }
  }
  $('#btn-copy-prompt').addEventListener('click', () => {
    const c = S.course;
    const text = courseText();
    const prompt = AI.promptForPaste({ title: courseTitle(), text, ...aiOptions(), hasAttachments: !!(c && (c.images.length || c.pdfs.some(p => p.scanned))) });
    copyText(prompt,
      () => say('msg-src', `<b>Consigne copiée</b> (${fmt(prompt.length)} caractères). Colle-la dans ton appli d'IA, puis reviens coller sa réponse à l'étape B.`, 'ok'),
      () => { $('#ai-reply').value = prompt; $('#ai-reply').focus(); $('#ai-reply').select(); say('msg-src', "La copie automatique n'a pas marché : la consigne est dans le champ B, sélectionne tout et copie-la, puis efface le champ pour y coller la réponse.", 'warn'); });
  });
  $('#btn-read-reply').addEventListener('click', () => {
    const raw = $('#ai-reply').value;
    if (!raw.trim()) { say('msg-src', "Colle d'abord la réponse de l'IA dans le champ B.", 'warn'); return; }
    const cards = normalizeCards(P.parseAIReply(raw));
    if (!cards.length) { say('msg-src', "Je ne trouve pas de fiches dans ce texte. Demande à l'IA de répondre uniquement avec le JSON de la consigne, puis recolle sa réponse.", 'err'); return; }
    const title = courseTitle();
    const existing = S.source.kind === 'ai' ? S.notes.filter(n => !n._removed) : [];
    const seen = new Set(existing.map(n => norm(n.front)));
    const fresh = cards.filter(c => { const k = norm(c.front); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    loadNotes({ kind: 'ai', fileName: title }, [...existing, ...fresh], S.deckName || title);
    say('msg-src', `<b>${plural(fresh.length, 'fiche lue', 'fiches lues')}</b>${existing.length ? ` (${fmt(S.notes.length)} au total)` : ''}. Relis-les, corrige ou retire ce qui ne va pas, puis envoie-les.`, 'ok');
    $('#ai-reply').value = '';
  });

  function cleanAI(s) {
    let t = String(s ?? '').trim();
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/&lt;(\/?)(b|i|u|sub|sup|br)\s*\/?&gt;/gi, (m, sl, tag) => `<${sl}${tag.toLowerCase()}>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\r?\n/g, '<br>');
    return t;
  }
  function normalizeCards(list) {
    const out = [];
    for (const c of list || []) {
      if (!c || typeof c !== 'object') continue;
      const front = cleanAI(c.front ?? c.question ?? c.recto ?? c.q);
      const back = cleanAI(c.back ?? c.answer ?? c.verso ?? c.reponse ?? c.r ?? '');
      if (!front) continue;
      const kind = /\{\{c\d+::/.test(front) ? 'cloze' : 'basic';
      if (kind === 'basic' && !back) continue;
      out.push({ kind, front, back, tags: [], cards: null });
    }
    return out;
  }
  const norm = (s) => P.htmlToText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Mode avec clé : appel direct
  function chunkText(text, size) {
    const paras = String(text).split(/\n{2,}/);
    const chunks = []; let cur = '';
    for (const p of paras) {
      if (p.length > size) { if (cur) { chunks.push(cur); cur = ''; } for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size)); continue; }
      if (cur && cur.length + p.length + 2 > size) { chunks.push(cur); cur = ''; }
      cur = cur ? cur + '\n\n' + p : p;
    }
    if (cur.trim()) chunks.push(cur);
    return chunks.filter(c => AI.countWords(c) >= 8);
  }
  async function runAI() {
    if (!settings.key) return;
    const opts = aiOptions();
    const title = courseTitle();
    const c = S.course || { text: '', images: [], pdfs: [] };
    const ctl = new AbortController();
    S.aiCtl = ctl;
    $('#btn-ai-stop').hidden = false; $('#ai-progress').hidden = false; $('#ai-bar').style.width = '3%';
    updatePromptButton();
    const jobs = [];
    try {
      // texte (docx, pptx, texte collé, PDF trop gros pour un envoi direct)
      let text = [c.text.trim(), $('#cours-text').value.trim()].filter(Boolean).join('\n\n');
      for (const p of c.pdfs) {
        const direct = p.file.size <= 20 * 1024 * 1024 && p.pages <= 90;
        if (direct) jobs.push({ pdf: p.file, pages: p.pages, title });
        else if (p.text) text += `\n\n# ${p.file.name}\n` + p.text;
        else { say('msg-src', 'Préparation des pages scannées…', 'pulse'); const imgs = await pdfPagesAsImages(p.doc, 40); for (let i = 0; i < imgs.length; i += 8) jobs.push({ images: imgs.slice(i, i + 8), title }); }
      }
      for (const ch of chunkText(text, 30000)) jobs.push({ text: ch, title });
      if (c.images.length) {
        say('msg-src', 'Préparation des photos…', 'pulse');
        const imgs = []; for (const f of c.images) imgs.push(await toJpeg(f, 1600));
        for (let i = 0; i < imgs.length; i += 8) jobs.push({ images: imgs.slice(i, i + 8), title });
      }
    } catch (e) { say('msg-src', errText(e), 'err'); return finishAI(); }
    if (!jobs.length) { say('msg-src', "Il n'y a rien à lire : choisis un cours ou colle son texte.", 'warn'); return finishAI(); }

    if (S.source.kind !== 'ai') loadNotes({ kind: 'ai', fileName: title }, [], title);
    const seen = new Set(S.notes.map(n => norm(n.front)));
    let added = 0, stopped = false, fatal = null; const failed = [];
    for (let i = 0; i < jobs.length; i++) {
      const label = jobs.length > 1 ? ` (partie ${i + 1} sur ${jobs.length})` : '';
      say('msg-src', `L'IA lit le cours et rédige les fiches${label}… Compte 30 secondes à 2 minutes.`, 'pulse');
      const avoid = S.notes.slice(-60).map(n => P.htmlToText(n.front).slice(0, 70));
      try {
        const r = await AI.generate({ provider: settings.provider, key: settings.key, model: settings.model.id, job: { ...jobs[i], ...opts, avoid }, signal: ctl.signal });
        const cards = normalizeCards(r.cards).filter(x => { const k = norm(x.front); if (!k || seen.has(k)) return false; seen.add(k); return true; });
        S.notes.push(...cards.map(prep)); added += cards.length; S.built = null;
        renderAll();
      } catch (e) {
        if (e.code === 'cancelled') { stopped = true; break; }
        if (['bad_key', 'no_credit', 'rate', 'network', 'server'].includes(e.code)) { fatal = e.message; break; }
        failed.push(i + 1); console.warn('partie', i + 1, e);
      }
      $('#ai-bar').style.width = Math.round(((i + 1) / jobs.length) * 100) + '%';
    }
    const kept = added ? ` ${plural(added, 'fiche a été créée', 'fiches ont été créées')}.` : '';
    if (fatal) say('msg-src', esc(fatal) + kept, 'err');
    else if (stopped) say('msg-src', `Arrêté.${kept || ' Aucune fiche créée.'}`, 'warn');
    else if (!added) say('msg-src', "L'IA n'a pas réussi à créer de fiches à partir de ce contenu. Réessaie, ou essaie avec moins de pages.", 'err');
    else say('msg-src', `<b>${plural(added, 'fiche créée', 'fiches créées')}.</b> Relis-les, corrige ou retire ce qui ne va pas, puis envoie-les.${failed.length ? ` La partie ${failed.join(', ')} n'a pas abouti : relance « Créer les fiches » pour compléter.` : ''}`, failed.length ? 'warn' : 'ok');
    finishAI();
    if (added) $('#step-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function finishAI() {
    S.aiCtl = null; $('#btn-ai-stop').hidden = true;
    setTimeout(() => { if (!S.aiCtl) $('#ai-progress').hidden = true; }, 1200);
    updatePromptButton();
  }
  $('#btn-ai').addEventListener('click', () => { runAI().catch(e => { say('msg-src', errText(e), 'err'); finishAI(); }); });
  $('#btn-ai-stop').addEventListener('click', () => { S.aiCtl?.abort(); });

  // ---------- aperçu ----------
  const activeNotes = () => S.notes.filter(n => !n._removed && !S.excluded.has(n.deck));
  function filteredNotes() {
    const f = S.filter.trim().toLowerCase();
    const a = activeNotes();
    return f ? a.filter(n => (P.htmlToText(n.front) + ' ' + P.htmlToText(n.back)).toLowerCase().includes(f)) : a;
  }
  function exportNotes() {
    const a = activeNotes();
    if (S.source.kind === 'anki' || S.source.kind === 'noji') return a;
    const name = (S.deckName || '').trim() || 'Mes fiches';
    return a.map(n => Object.assign({}, n, { deck: n.ownDeck || name }));
  }
  function packTitle() {
    if (S.source.kind === 'anki' || S.source.kind === 'noji') {
      const tops = new Set(activeNotes().map(n => n.deck.split('::')[0]));
      return tops.size === 1 ? [...tops][0] : (S.source.kind === 'noji' ? 'Paquets Noji' : 'Paquets Anki');
    }
    return (S.deckName || '').trim() || 'Mes fiches';
  }
  const safeFile = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'fiches';
  function safeHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html || '').replace(/\[sound:([^\]]+)\]/g, (m, f) => `<span class="son">son : ${esc(f)}</span>`);
    t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,audio,video').forEach(e => e.remove());
    t.content.querySelectorAll('*').forEach(el => {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || (n === 'class' && el.tagName !== 'SPAN') || n === 'id') el.removeAttribute(a.name);
        else if (['href', 'src', 'xlink:href', 'action'].includes(n) && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        else if (n === 'style' && /url\(|position|expression/i.test(a.value)) el.removeAttribute(a.name);
      }
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || '';
        el.removeAttribute('src');
        if (src && !/^(https?:|data:|blob:)/i.test(src)) el.dataset.media = src;
        el.alt = src ? 'Image : ' + src : 'Image'; el.loading = 'lazy';
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
    });
    return t.innerHTML;
  }
  const clozeDisplay = (html) => String(html || '').replace(/\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g, (m, n, a) => `<span class="trou">${a}</span>`);
  const toEdit = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n');
  const fromEdit = (txt) => String(txt || '').replace(/\r?\n/g, '<br>');
  const deckLabel = (d) => d.split('::').join(' › ');
  const hasOwnDecks = () => S.source.kind === 'anki' || S.source.kind === 'noji';

  function renderDecks() {
    const box = $('#decks');
    if (!hasOwnDecks()) { box.hidden = true; return; }
    const counts = new Map();
    for (const n of S.notes) if (!n._removed) counts.set(n.deck, (counts.get(n.deck) || 0) + 1);
    if (counts.size < 2) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr')).map(([d, c]) =>
      `<button type="button" class="chip" data-deck="${esc(d)}" aria-pressed="${!S.excluded.has(d)}">${esc(deckLabel(d))} <span class="n">${fmt(c)}</span></button>`).join('');
  }
  $('#decks').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    const d = b.dataset.deck;
    if (S.excluded.has(d)) S.excluded.delete(d); else S.excluded.add(d);
    S.built = null; renderAll();
  });
  function renderSummary() {
    const a = activeNotes();
    const cloze = a.filter(n => n.kind === 'cloze').length;
    const ankiCards = a.reduce((s, n) => s + (n.kind === 'cloze' ? Math.max(1, P.clozeOrds(n.front).length) : 1), 0);
    const media = new Set(); for (const n of a) for (const m of P.mediaRefs(n.front + ' ' + n.back)) media.add(m);
    const withProg = S.source.kind === 'anki' ? a.filter(n => (n.cards || []).some(c => c.type !== 0)).length : 0;
    if (!S.notes.length) { $('#summary').innerHTML = `<span class="muted">${S.aiCtl ? 'Les fiches apparaîtront ici au fur et à mesure.' : 'Les fiches apparaîtront ici.'}</span>`; }
    else {
      const bits = [`<strong>${fmt(a.length)}</strong> ${a.length > 1 ? 'fiches' : 'fiche'}`];
      if (cloze) bits.push(plural(cloze, 'texte à trous', 'textes à trous'));
      if (ankiCards !== a.length) bits.push(`${fmt(ankiCards)} cartes dans Anki`);
      if (media.size) bits.push(plural(media.size, 'image ou son', 'images ou sons'));
      if (withProg) bits.push(`progression sur ${fmt(withProg)}`);
      $('#summary').innerHTML = bits.map(b => `<span>${b}</span>`).join('');
    }
    const showProg = withProg > 0;
    $('#progress-anki').hidden = !showProg; $('#progress-noji').hidden = !showProg;
    $$('.keep-progress').forEach(cb => { cb.checked = S.keepProgress; });
    $('#noji-sub').textContent = media.size
      ? `Ce paquet contient ${plural(media.size, 'image ou son', 'images ou sons')} : le copier-coller ne garde que le texte. Pour tout garder, ouvre « Garder les images et la progression ».`
      : 'Le plus rapide : copie les fiches, puis colle-les dans Noji.';
    if (media.size || showProg) $('#noji-more').open = true;
    const none = !a.length;
    ['btn-share-anki', 'btn-dl-anki', 'btn-noji-copy', 'btn-noji-apkg', 'btn-noji-csv'].forEach(id => { $('#' + id).disabled = none; });
    $('#step-preview').classList.toggle('done', !none);
    $('#step-source').classList.toggle('done', S.notes.length > 0);
    $('#step-send').toggleAttribute('inert', none);
  }
  function ficheHtml(n) {
    const kind = n.kind === 'cloze' ? 'Texte à trous' : 'Question';
    const deck = hasOwnDecks() ? deckLabel(n.deck) : (n.ownDeck ? deckLabel(n.ownDeck) : '');
    if (n._editing) {
      return `<article class="fiche editing" data-uid="${n._uid}">
        <div class="fiche-top"><span class="kind">${kind}</span><span class="deck"></span><button type="button" data-act="save">Enregistrer</button></div>
        <div class="recto"><label class="muted" for="ef-${n._uid}">Recto</label><textarea id="ef-${n._uid}" data-f="front">${esc(toEdit(n.front))}</textarea></div>
        <div class="verso" style="background:none"><label class="muted" for="eb-${n._uid}">Verso</label><textarea id="eb-${n._uid}" data-f="back">${esc(toEdit(n.back))}</textarea>
          <p class="muted" style="line-height:1.4">Pour un texte à trous, écris {{c1::mot}} au recto.</p></div>
      </article>`;
    }
    return `<article class="fiche" data-uid="${n._uid}">
      <div class="fiche-top"><span class="kind">${kind}</span><span class="deck">${esc(deck)}</span>
        <button type="button" data-act="edit">Modifier</button><button type="button" data-act="del" aria-label="Retirer cette fiche">Retirer</button></div>
      <div class="recto">${safeHtml(n.kind === 'cloze' ? clozeDisplay(n.front) : n.front)}</div>
      <div class="verso">${safeHtml(n.back)}</div>
    </article>`;
  }
  function hydrateImages(root) { $$('img[data-media]', root).forEach(img => { mediaUrl(img.dataset.media).then(u => { if (u) img.src = u; }); }); }
  function renderGrid() {
    const list = filteredNotes();
    const grid = $('#grid');
    if (!list.length) {
      grid.innerHTML = S.notes.length ? '<div class="empty">Aucune fiche ne correspond.</div>' : '';
      $('#btn-more').hidden = true; return;
    }
    const slice = list.slice(0, S.shown);
    grid.innerHTML = slice.map(ficheHtml).join('');
    const rest = list.length - slice.length;
    $('#btn-more').hidden = rest <= 0;
    $('#btn-more').textContent = `Afficher ${fmt(Math.min(rest, 48))} fiches de plus (${fmt(rest)} restantes)`;
    hydrateImages(grid);
  }
  $('#btn-more').addEventListener('click', () => { S.shown += 48; renderGrid(); });
  function renderAll(scroll) {
    $('#deck-name').value = S.deckName;
    $('#deckname-field').hidden = hasOwnDecks() || !S.notes.length;
    $('#filter-field').hidden = S.notes.length <= 24;
    renderDecks(); renderSummary(); renderGrid();
    say('msg-anki', ''); say('msg-noji', ''); $('#howto-anki').innerHTML = ''; $('#copybox').hidden = true;
    $('#btn-share-anki').hidden = !canShareFiles;
    $('#btn-dl-anki').classList.toggle('primary', !canShareFiles);
    $('#btn-dl-anki').textContent = canShareFiles ? 'Télécharger le paquet' : 'Télécharger le paquet Anki';
    schedulePrebuild();
    if (scroll && S.notes.length) $('#step-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#grid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const card = b.closest('.fiche');
    const n = S.notes.find(x => x._uid === +card.dataset.uid); if (!n) return;
    if (b.dataset.act === 'del') {
      n._removed = true; S.lastRemoved = n; S.built = null;
      say('msg-prev', 'Fiche retirée. <button type="button" class="link" id="undo">Annuler</button>');
      renderSummary(); renderDecks(); card.remove();
      if (!filteredNotes().length) renderGrid();
      schedulePrebuild();
    } else if (b.dataset.act === 'edit') {
      n._editing = true; card.outerHTML = ficheHtml(n); $(`#ef-${n._uid}`)?.focus();
    } else if (b.dataset.act === 'save') {
      n.front = fromEdit($(`#ef-${n._uid}`).value.trim()); n.back = fromEdit($(`#eb-${n._uid}`).value.trim());
      n.kind = P.clozeOrds(n.front).length ? 'cloze' : 'basic';
      n._editing = false; S.built = null;
      card.outerHTML = ficheHtml(n);
      hydrateImages($(`.fiche[data-uid="${n._uid}"]`));
      renderSummary(); schedulePrebuild();
    }
  });
  $('#msg-prev').addEventListener('click', (e) => {
    if (e.target.id !== 'undo' || !S.lastRemoved) return;
    S.lastRemoved._removed = false; S.lastRemoved = null; S.built = null;
    say('msg-prev', ''); renderAll();
  });
  $('#deck-name').addEventListener('input', (e) => { S.deckName = e.target.value; S.built = null; schedulePrebuild(); });
  let filterT;
  $('#filter').addEventListener('input', (e) => { clearTimeout(filterT); filterT = setTimeout(() => { S.filter = e.target.value; S.shown = 24; renderGrid(); }, 180); });
  $$('.keep-progress').forEach(cb => cb.addEventListener('change', () => { S.keepProgress = cb.checked; $$('.keep-progress').forEach(o => { o.checked = cb.checked; }); S.built = null; schedulePrebuild(); }));

  // ---------- construction du paquet ----------
  async function buildPackage() {
    await ensureCore();
    const src = S.source;
    const keep = src.kind === 'anki' && S.keepProgress;
    return P.buildApkg({
      notes: exportNotes(), withProgress: keep,
      crt: src.kind === 'anki' ? src.pkg.crt : null, schedVer: src.kind === 'anki' ? src.pkg.schedVer : 2,
      revlog: keep ? src.pkg.revlog : null, getMedia: src.media ? src.media.get : null
    });
  }
  function ensureBuilt() {
    if (S.built) return S.built;
    const v = ++S.buildVersion;
    const p = buildPackage().then(out => { if (S.built === p) out.file = new File([out.bytes], safeFile(packTitle()) + '.apkg', { type: 'application/octet-stream' }); return out; });
    p.catch(() => { if (S.built === p) S.built = null; });
    S.built = p;
    return p;
  }
  function schedulePrebuild() {
    clearTimeout(S.buildTimer);
    if (!activeNotes().length || activeNotes().length > 4000) return;
    S.buildTimer = setTimeout(() => { ensureBuilt().catch(() => {}); }, 700);
  }
  function downloadBlob(filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 20000);
  }
  function busy(btn, on) { btn.classList.toggle('busy', on); btn.disabled = on; }
  function outSummary(out) { return `${plural(out.cards, 'carte', 'cartes')}${out.media ? `, ${plural(out.media, 'média', 'médias')}` : ''}${out.missingMedia.length ? ` · ${plural(out.missingMedia.length, 'image absente du fichier d\'origine', 'images absentes du fichier d\'origine')}` : ''}`; }

  // Envoyer vers Anki (menu Partager)
  let pendingShare = null;
  $('#btn-share-anki').addEventListener('click', async () => {
    const btn = $('#btn-share-anki');
    if (pendingShare) {
      const f = pendingShare; pendingShare = null; btn.textContent = 'Envoyer vers Anki';
      try { await navigator.share({ files: [f] }); say('msg-anki', '<b>Envoyé.</b> Anki importe le paquet.', 'ok'); }
      catch (e) { if (e && e.name !== 'AbortError') say('msg-anki', "Le partage n'a pas marché : utilise « Télécharger le paquet », puis ouvre-le depuis Fichiers.", 'warn'); }
      return;
    }
    if (!S.built) busy(btn, true);
    say('msg-anki', 'Préparation du paquet…', 'pulse');
    let out;
    try { out = await ensureBuilt(); }
    catch (e) { say('msg-anki', errText(e), 'err'); busy(btn, false); return; }
    busy(btn, false);
    try {
      await navigator.share({ files: [out.file] });
      say('msg-anki', `<b>Envoyé</b> (${outSummary(out)}). Anki importe le paquet.`, 'ok');
    } catch (e) {
      if (e && e.name === 'AbortError') { say('msg-anki', `Paquet prêt (${outSummary(out)}). Touche « Envoyer vers Anki » et choisis <b>Anki</b> dans le menu.`); return; }
      // activation perdue pendant la préparation : un second toucher suffit
      pendingShare = out.file; btn.textContent = 'Touche pour envoyer vers Anki';
      say('msg-anki', `Paquet prêt (${outSummary(out)}). Touche encore une fois le bouton, puis choisis <b>Anki</b> dans le menu.`, 'ok');
    }
  });
  // Télécharger le paquet
  $('#btn-dl-anki').addEventListener('click', async () => {
    const btn = $('#btn-dl-anki');
    busy(btn, true); say('msg-anki', 'Préparation du paquet…', 'pulse');
    try {
      const out = await ensureBuilt();
      downloadBlob(out.file.name, out.file);
      say('msg-anki', `<b>Paquet prêt</b> : ${outSummary(out)}.`, 'ok');
      $('#howto-anki').innerHTML = (isIOS
        ? [`Si Safari demande « Télécharger ? », accepte. Le fichier arrive dans <b>Fichiers › Téléchargements</b> (icône <b>⤓</b> en haut de Safari).`,
           `Touche <b>${esc(out.file.name)}</b>, puis <b>Partager</b> → <b>Anki</b>. L'import démarre tout seul.`]
        : [`Ouvre <b>${esc(out.file.name)}</b> dans tes téléchargements : Anki l'importe directement (ou Fichier → Importer dans Anki).`]
      ).map(s => `<li>${s}</li>`).join('');
    } catch (e) { say('msg-anki', errText(e), 'err'); }
    finally { busy(btn, false); }
  });
  // Noji : copier
  $('#btn-noji-copy').addEventListener('click', () => {
    const notes = exportNotes();
    const text = P.toPasteText(notes);
    copyText(text,
      () => { $('#copybox').hidden = true; say('msg-noji', `<b>${plural(notes.length, 'fiche copiée', 'fiches copiées')}.</b> Ouvre noji.io et colle-les dans « Import Cards ».`, 'ok'); },
      () => { $('#copybox').hidden = false; const ta = $('#copytext'); ta.value = text; ta.focus(); ta.select(); say('msg-noji', ''); });
  });
  $('#btn-noji-apkg').addEventListener('click', async () => {
    const btn = $('#btn-noji-apkg');
    busy(btn, true); say('msg-noji', 'Préparation du fichier…', 'pulse');
    try {
      const out = await ensureBuilt();
      const name = safeFile(packTitle()) + ' (Noji).apkg';
      downloadBlob(name, out.bytes, 'application/octet-stream');
      say('msg-noji', `<b>Fichier prêt</b> (${outSummary(out)}). Sur noji.io, choisis l'import de paquet Anki et prends <b>${esc(name)}</b> dans Fichiers › Téléchargements.`, 'ok');
    } catch (e) { say('msg-noji', errText(e), 'err'); }
    finally { busy(btn, false); }
  });
  $('#btn-noji-csv').addEventListener('click', () => {
    try {
      downloadBlob(safeFile(packTitle()) + '.csv', '﻿' + P.toCSV(exportNotes()), 'text/csv;charset=utf-8');
      say('msg-noji', '<b>CSV prêt</b> (dans Téléchargements). Dans Noji : paquet → Import Cards → importe le fichier.', 'ok');
    } catch (e) { say('msg-noji', errText(e), 'err'); }
  });

  // ---------- réglages ----------
  function openSettings() { $('#settings').hidden = false; $('#api-key').value = settings.key || ''; say('msg-key', settings.key && settings.model ? `Clé enregistrée · modèle : ${esc(settings.model.label)}` : ''); $('#settings-close').focus(); }
  function closeSettings() { $('#settings').hidden = true; }
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#settings').hidden) closeSettings(); });
  $$('[data-open-settings]').forEach(b => b.addEventListener('click', openSettings));
  $('#btn-key-save').addEventListener('click', async () => {
    const key = $('#api-key').value.trim();
    const provider = AI.detectProvider(key);
    if (!key) { say('msg-key', 'Colle une clé, ou touche « Effacer la clé » pour revenir au mode sans clé.', 'warn'); return; }
    if (!provider) { say('msg-key', "Cette clé n'a pas la forme attendue : une clé Anthropic commence par sk-ant-, une clé OpenAI par sk-.", 'err'); return; }
    const btn = $('#btn-key-save'); busy(btn, true);
    say('msg-key', 'Vérification de la clé…', 'pulse');
    try {
      const model = await AI.pickModel(provider, key);
      settings.key = key; settings.provider = provider; settings.model = model;
      store.set('key', key); store.set('provider', provider); store.set('model', model);
      say('msg-key', `<b>Clé valide.</b> Les fiches seront créées avec ${esc(model.label)} (${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'}).`, 'ok');
      renderAIMode();
    } catch (e) { say('msg-key', errText(e), 'err'); }
    finally { busy(btn, false); }
  });
  $('#btn-key-clear').addEventListener('click', () => {
    settings.key = ''; settings.provider = null; settings.model = null;
    store.del('key'); store.del('provider'); store.del('model');
    $('#api-key').value = '';
    say('msg-key', 'Clé effacée. Pont repasse en mode sans clé.', 'ok');
    renderAIMode();
  });

  // ---------- écran d'accueil (PWA) ----------
  if (isIOS && !isStandalone && !store.get('installDismissed', false)) $('#install-hint').hidden = false;
  $('#install-dismiss').addEventListener('click', () => { store.set('installDismissed', true); $('#install-hint').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }

  // ---------- démarrage ----------
  renderAIMode();
  showHome();
})();
