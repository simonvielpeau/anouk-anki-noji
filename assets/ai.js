/* Pont — création de fiches par IA : consigne partagée, appel direct Anthropic ou OpenAI avec la clé de l'utilisateur. */
(function (root) {
  'use strict';

  const TYPE_RULES = {
    mix: 'Mélange les deux types : questions/réponses ("basic") pour ce qui demande une explication, textes à trous ("cloze") pour les définitions, termes précis, chiffres et dates.',
    qa: 'Toutes les fiches sont de type "basic" : une question au recto, la réponse au verso.',
    cloze: 'Toutes les fiches sont de type "cloze" : une phrase autonome tirée du cours, avec 1 ou 2 trous notés {{c1::…}} puis {{c2::…}} sur les mots essentiels. "back" peut contenir un court complément ou rester vide.'
  };
  const DENSITY = { light: 260, normal: 130, full: 70 }; // mots par fiche
  const PER_PAGE = { light: 2, normal: 4, full: 7 };     // fiches par page / photo

  function rules({ type, target, hint, avoid }) {
    return [
      "Tu es un enseignant expert en mémorisation et en répétition espacée. Rédige des fiches de révision (flashcards) à partir du cours fourni.",
      '',
      'Règles :',
      '- Une seule notion par fiche. Question précise ; réponse courte (une phrase, ou une liste de 2 à 4 éléments).',
      "- Couvre ce qui compte pour un examen : définitions, notions clés, mécanismes, causes et conséquences, chiffres, dates, formules, classifications, exemples importants.",
      "- N'invente rien : uniquement ce qui figure dans le cours. Ignore les en-têtes, numéros de page, sommaires et informations administratives.",
      '- Écris dans la langue du cours.',
      "- Chaque fiche se comprend seule, sans « d'après le texte » ni « dans ce cours ».",
      '- ' + TYPE_RULES[type || 'mix'],
      target ? `- Vise environ ${target} fiches, moins si le contenu est léger.` : '',
      '- Mise en forme autorisée : <b>, <i>, <sub>, <sup>, <br>. Pas de Markdown ni de LaTeX : écris les formules en texte (H<sub>2</sub>O, x² + 1).',
      hint ? `- Consigne de l'élève : ${hint}` : '',
      avoid && avoid.length ? '- Ces fiches existent déjà, ne les refais pas : ' + avoid.join(' | ') : ''
    ].filter(l => l !== '').join('\n');
  }
  const FORMAT = 'Réponds uniquement avec ce JSON, sans commentaire :\n{"cards":[{"type":"basic","front":"Question ?","back":"Réponse"},{"type":"cloze","front":"La {{c1::mitochondrie}} produit l\'essentiel de l\'ATP.","back":""}]}';

  function countWords(t) { const m = String(t || '').match(/[\p{L}\p{N}]+/gu); return m ? m.length : 0; }
  function targetFor(words, pages, qty) {
    qty = qty || 'normal';
    const t = words ? Math.round(words / DENSITY[qty]) : 0;
    const p = pages ? pages * PER_PAGE[qty] : 0;
    return Math.max(4, Math.min(60, Math.max(t, p)));
  }

  // Consigne complète pour le mode « sans clé » (collée dans l'app Claude / ChatGPT)
  function promptForPaste({ title, text, type, qty, hint, hasAttachments }) {
    const words = countWords(text);
    const body = [rules({ type, target: targetFor(words, hasAttachments ? 6 : 0, qty), hint }), '', FORMAT, ''];
    if (text && text.trim()) body.push(`Cours « ${title} » :\n"""\n${text.trim().slice(0, 60000)}\n"""`);
    if (hasAttachments) body.push(text && text.trim() ? "\nLe cours comprend aussi le ou les fichiers joints à ce message." : `Le cours « ${title} » est dans le ou les fichiers joints à ce message : lis-les attentivement, y compris l'écriture manuscrite.`);
    return body.join('\n');
  }

  function detectProvider(key) {
    key = String(key || '').trim();
    if (!key) return null;
    if (/^sk-ant-/i.test(key)) return 'anthropic';
    if (/^sk-/i.test(key)) return 'openai';
    return null;
  }

  async function readJson(res) {
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { /* pas du JSON */ }
    return { j, txt };
  }
  function apiError(res, j, provider) {
    const msg = (j && (j.error?.message || j.message)) || '';
    if (res.status === 401 || res.status === 403) return err('bad_key', provider === 'openai' ? "Clé OpenAI refusée. Vérifie-la dans les réglages." : "Clé Anthropic refusée. Vérifie-la dans les réglages.");
    if (res.status === 402 || /insufficient|credit|quota|billing/i.test(msg)) return err('no_credit', "Le compte lié à cette clé n'a plus de crédit. Recharge-le sur le site du fournisseur, puis réessaie.");
    if (res.status === 429) return err('rate', 'Trop de demandes en même temps. Attends une minute, puis réessaie.');
    if (res.status === 413 || /too large|exceed|maximum.*(size|pages)/i.test(msg)) return err('too_large', 'Le cours est trop gros pour un seul envoi. Essaie avec moins de pages, ou en plusieurs fois.');
    if (res.status >= 500) return err('server', "Le service d'IA ne répond pas pour le moment. Réessaie dans quelques minutes.");
    return err('api', msg ? `Le service d'IA a renvoyé une erreur : ${msg}` : `Le service d'IA a renvoyé une erreur (${res.status}).`);
  }
  function err(code, message) { const e = new Error(message); e.code = code; e.ui = true; return e; }
  function netError(e) {
    if (e && e.name === 'AbortError') return err('cancelled', 'Arrêté.');
    return err('network', "Impossible de joindre le service d'IA. Vérifie la connexion internet, puis réessaie.");
  }

  const SCHEMA = {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['basic', 'cloze'] }, front: { type: 'string' }, back: { type: 'string' } },
          required: ['type', 'front', 'back'],
          additionalProperties: false
        }
      }
    },
    required: ['cards'],
    additionalProperties: false
  };

  const ANTHROPIC_HEADERS = (key) => ({
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  });

  // Choix du modèle : on interroge la liste des modèles disponibles avec cette clé.
  async function pickModel(provider, key, signal) {
    if (provider === 'anthropic') {
      let res;
      try { res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: ANTHROPIC_HEADERS(key), signal }); }
      catch (e) { throw netError(e); }
      const { j } = await readJson(res);
      if (!res.ok) throw apiError(res, j, provider);
      const models = (j && j.data) || [];
      const rank = (id) => /sonnet/.test(id) ? 3 : /opus/.test(id) ? 2 : /haiku/.test(id) ? 1 : 0;
      const sorted = models.filter(m => rank(m.id)).sort((a, b) => rank(b.id) - rank(a.id) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
      if (!sorted.length) throw err('no_model', "Aucun modèle Claude n'est disponible avec cette clé.");
      return { id: sorted[0].id, label: sorted[0].display_name || sorted[0].id };
    }
    let res;
    try { res = await fetch('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + key }, signal }); }
    catch (e) { throw netError(e); }
    const { j } = await readJson(res);
    if (!res.ok) throw apiError(res, j, provider);
    const ids = new Set(((j && j.data) || []).map(m => m.id));
    const prefs = ['gpt-5-mini', 'gpt-5.1-mini', 'gpt-5', 'gpt-5.1', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o'];
    const id = prefs.find(p => ids.has(p)) || [...ids].find(x => /^gpt-(5|4\.1|4o)/.test(x));
    if (!id) throw err('no_model', "Aucun modèle GPT compatible n'est disponible avec cette clé.");
    return { id, label: id };
  }

  function b64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  async function blobB64(blob) { return b64(new Uint8Array(await blob.arrayBuffer())); }

  /**
   * Une requête de génération.
   * job = { text?, images?: Blob[] (jpeg/png/webp/gif), pdf?: Blob, title, type, qty, hint, avoid?, pages? }
   * Retourne { cards: [...], model, usage }
   */
  async function generate({ provider, key, model, job, signal, onStatus }) {
    const words = countWords(job.text);
    const target = targetFor(words, job.pages || (job.images ? job.images.length : 0), job.qty);
    const instructions = rules({ type: job.type, target, hint: job.hint, avoid: job.avoid });
    const intro = job.text && job.text.trim()
      ? `Cours « ${job.title} » :\n"""\n${job.text.trim()}\n"""` + (job.pdf || (job.images && job.images.length) ? "\n\nLe cours comprend aussi le document ou les images ci-joints." : '')
      : `Le cours « ${job.title} » est dans le document ou les images ci-joints. Lis-les attentivement, y compris l'écriture manuscrite.`;

    if (provider === 'anthropic') {
      const content = [];
      if (job.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await blobB64(job.pdf) } });
      for (const img of job.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: img.type || 'image/jpeg', data: await blobB64(img) } });
      content.push({ type: 'text', text: intro + '\n\n' + FORMAT });
      const body = {
        model, max_tokens: 16000, system: instructions,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } }
      };
      onStatus && onStatus('envoi');
      let res;
      try { res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: ANTHROPIC_HEADERS(key), body: JSON.stringify(body), signal }); }
      catch (e) { throw netError(e); }
      let { j } = await readJson(res);
      if (!res.ok && res.status === 400 && /output_config|json_schema|format/i.test(j?.error?.message || '')) {
        // modèle sans sortie structurée : on redemande sans contrainte
        delete body.output_config;
        try { res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: ANTHROPIC_HEADERS(key), body: JSON.stringify(body), signal }); }
        catch (e) { throw netError(e); }
        ({ j } = await readJson(res));
      }
      if (!res.ok) throw apiError(res, j, provider);
      if (j.stop_reason === 'refusal') throw err('refused', "L'IA a refusé de traiter ce contenu.");
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      return { cards: root.PontCore.parseAIReply(text), model, usage: j.usage, truncated: j.stop_reason === 'max_tokens' };
    }

    // OpenAI — Chat Completions
    const parts = [];
    if (job.pdf) parts.push({ type: 'file', file: { filename: (job.title || 'cours') + '.pdf', file_data: 'data:application/pdf;base64,' + await blobB64(job.pdf) } });
    for (const img of job.images || []) parts.push({ type: 'image_url', image_url: { url: `data:${img.type || 'image/jpeg'};base64,` + await blobB64(img) } });
    parts.push({ type: 'text', text: intro + '\n\n' + FORMAT });
    const body = {
      model,
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: parts }],
      max_completion_tokens: 16000,
      response_format: { type: 'json_schema', json_schema: { name: 'fiches', strict: true, schema: SCHEMA } }
    };
    onStatus && onStatus('envoi');
    const call = async () => {
      let res;
      try { res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body), signal }); }
      catch (e) { throw netError(e); }
      return { res, ...(await readJson(res)) };
    };
    let r = await call();
    if (!r.res.ok && r.res.status === 400 && /response_format|json_schema|max_completion_tokens/i.test(r.j?.error?.message || '')) {
      body.response_format = { type: 'json_object' };
      if (/max_completion_tokens/i.test(r.j?.error?.message || '')) { delete body.max_completion_tokens; body.max_tokens = 16000; }
      r = await call();
    }
    if (!r.res.ok) throw apiError(r.res, r.j, provider);
    const choice = (r.j.choices || [])[0] || {};
    if (choice.message?.refusal) throw err('refused', "L'IA a refusé de traiter ce contenu.");
    const text = choice.message?.content || '';
    return { cards: root.PontCore.parseAIReply(text), model, usage: r.j.usage, truncated: choice.finish_reason === 'length' };
  }

  root.PontAI = { promptForPaste, detectProvider, pickModel, generate, countWords, targetFor, TYPE_RULES };
})(typeof window !== 'undefined' ? window : globalThis);
