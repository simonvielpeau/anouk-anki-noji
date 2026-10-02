# Pont · Anki ⇄ Noji

Site statique (aucun serveur) pour passer des fiches d'Anki à Noji et de Noji à Anki, ou créer des fiches à partir d'un cours.
Fonctionne sur iPad (Safari, ajout à l'écran d'accueil possible), Mac et PC.

- `index.html`, `assets/` : l'application.
- `assets/core.js` : lecture des paquets Anki (.apkg/.colpkg, anciens et récents), des exports Noji (.ofc, CSV), écriture d'un .apkg compatible.
- `assets/ai.js` : consigne pour l'IA et appel direct (clé Anthropic ou OpenAI, facultatif).
- `vendor/` : bibliothèques embarquées (sql.js, JSZip, fzstd, pdf.js, mammoth).
- `sw.js` : cache hors ligne. Changer `VERSION` à chaque mise à jour.

Les fichiers de l'utilisateur ne quittent pas le navigateur ; seule la création par IA envoie le cours au fournisseur choisi.
