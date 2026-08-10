# Suivi des agents responsables

Site interne de suivi de l’intégration des nouveaux agents, publié sur `responsable.esapin.com`.

## Accès

- La connexion utilise uniquement un code personnel de six chiffres, enregistré dans la colonne D (`Code d’accès`) de l’onglet `Annuaire`, puis synchronisé dans le secret Cloudflare `ACCESS_DIRECTORY_JSON` lors de la publication.
- Les lignes dont le poste contient `Chef` sont autorisées. `SAPIN EDDY` est l’administrateur explicitement autorisé.
- Les codes doivent être uniques. Un code dupliqué est refusé.
- La suppression ou la modification d’un code, suivie de la synchronisation du secret, invalide aussi les sessions déjà ouvertes avec l’ancien code.
- Aucun e-mail et aucun code d’accès ne doivent être ajoutés au dépôt.

## Architecture

- Le site statique affiche la connexion et les écrans de suivi.
- le Worker Cloudflare `suivi-agents-api` contrôle l’origine, limite les tentatives, signe les sessions dans un cookie sécurisé et protège toutes les actions de lecture et d’écriture ;
- le Worker conserve les cinq identités autorisées dans un secret chiffré, jamais dans le dépôt ;
- Apps Script écrit dans les feuilles et documents Google ;
- les situations utilisent l’action sécurisée Apps Script lorsqu’elle est disponible et, sur l’ancienne version encore déployée, passent par le formulaire Google existant depuis le Worker uniquement.

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

L’ordre de publication est impératif : synchroniser `ACCESS_DIRECTORY_JSON`, publier le Worker et son domaine personnalisé, puis publier le site statique. Les valeurs `API_KEY`, `APPS_SCRIPT_KEY`, `APPS_SCRIPT_URL`, `SESSION_SECRET` et `ACCESS_DIRECTORY_JSON` restent dans les propriétés ou secrets des services et ne sont jamais versionnées.
