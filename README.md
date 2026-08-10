# Suivi des agents responsables

Site interne de suivi de l’intégration des nouveaux agents, publié sur `responsable.esapin.com`.

## Accès

- La connexion utilise uniquement un code personnel de six chiffres, enregistré dans l’annuaire privé puis synchronisé dans le secret Cloudflare `ACCESS_DIRECTORY_JSON` lors de la publication.
- Les quatre chefs et l’administrateur Eddy Sapin sont autorisés.
- Les codes doivent être uniques. Un code dupliqué est refusé.
- La suppression ou la modification d’un code, suivie de la synchronisation du secret, invalide aussi les sessions déjà ouvertes avec l’ancien code.
- Aucun e-mail et aucun code d’accès ne doivent être ajoutés au dépôt.

## Architecture

- Le site statique `responsable.esapin.com` affiche la connexion et les écrans de suivi.
- Le Worker Cloudflare `suivi-agents-api`, exposé sur `responsable-api.esapin.com`, contrôle l’origine, limite les tentatives, signe les sessions dans un cookie sécurisé et protège toutes les actions de lecture et d’écriture.
- Le Worker conserve les identités autorisées et leurs codes dans le secret chiffré `ACCESS_DIRECTORY_JSON`, jamais dans le dépôt.
- Apps Script écrit dans les feuilles et documents Google.
- Les situations passent par l’action sécurisée Apps Script lorsqu’elle est disponible ; le Worker garde une compatibilité serveur avec l’ancien formulaire Google tant que nécessaire.

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

L’ordre de publication est impératif : synchroniser `ACCESS_DIRECTORY_JSON`, publier le Worker sur `responsable-api.esapin.com`, tester l’API, puis publier le site statique. Les valeurs `API_KEY`, `APPS_SCRIPT_KEY`, `APPS_SCRIPT_URL`, `SESSION_SECRET` et `ACCESS_DIRECTORY_JSON` restent dans les propriétés ou secrets des services et ne sont jamais versionnées.
