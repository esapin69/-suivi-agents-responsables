# Suivi des agents responsables

Site interne de suivi de l’intégration des nouveaux agents, publié sur `responsable.esapin.com`.

## Accès

- La connexion utilise uniquement un code personnel de six chiffres lu directement dans l’onglet `Annuaire` du fichier source Google Sheets.
- Les quatre chefs et l’administrateur Eddy Sapin sont autorisés.
- Une cellule vide n’autorise aucun accès ; un code présent devient utilisable immédiatement.
- Les codes doivent être uniques. Un code dupliqué est refusé.
- Modifier ou supprimer un code dans le Sheet invalide l’ancien accès et les sessions correspondantes lors de leur prochaine validation.
- Aucun e-mail et aucun code d’accès ne doivent être ajoutés au dépôt GitHub ni copiés dans Cloudflare.

## Architecture

- Le site statique `responsable.esapin.com` affiche la connexion et les écrans de suivi.
- Le Worker Cloudflare `suivi-agents-api`, exposé sur `responsable-api.esapin.com`, contrôle l’origine, limite les tentatives, signe les sessions dans un cookie sécurisé et protège toutes les actions de lecture et d’écriture.
- Le Worker délègue l’authentification et la revalidation des sessions à Apps Script, qui lit directement l’onglet `Annuaire` du Google Sheet.
- Apps Script écrit dans les feuilles et documents Google et impose l’identité du responsable connecté pour les écritures concernées.

## Fonctionnalités

- Accueil : **Suivi des agents** et **Prendre des notes**.
- Suivi : **Suivre un agent** et **Ajouter un agent**.
- Fiche agent : **Suivi d’intégration**, **Évaluations** et **Situations / événements**.
- Évaluations : brouillons, version officielle, PDF et choix **Éléments insuffisants pour évaluer**.

## Vérifications locales

```bash
node --test site-security.test.cjs apps-script/security.test.cjs
npm test --prefix backend
./backend/node_modules/.bin/tsc --noEmit -p backend/tsconfig.json
```

L’ordre de publication est impératif : publier la version Apps Script qui contient `authenticateAccess` et `authorizeAccess`, publier le Worker sur `responsable-api.esapin.com`, tester l’API et la connexion, puis publier le site statique. Les valeurs `API_KEY`, `APPS_SCRIPT_KEY`, `APPS_SCRIPT_URL` et `SESSION_SECRET` restent dans les propriétés ou secrets des services et ne sont jamais versionnées.
