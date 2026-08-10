# Suivi des agents responsables

Site interne de suivi de l’intégration des nouveaux agents, publié sur `responsable.esapin.com`.

## Accès

- La connexion utilise uniquement un code personnel de six chiffres, enregistré dans la colonne D (`Code d’accès`) de l’onglet `Annuaire`.
- Les lignes dont le poste contient `Chef` sont autorisées. `SAPIN EDDY` est l’administrateur explicitement autorisé.
- Les codes doivent être uniques. Un code dupliqué est refusé.
- La suppression ou la modification d’un code invalide aussi les sessions déjà ouvertes avec l’ancien code.
- Aucun e-mail et aucun code d’accès ne doivent être ajoutés au dépôt.

## Architecture

- Le site statique affiche la connexion et les écrans de suivi.
- le Worker Cloudflare `suivi-agents-api` contrôle l’origine, limite les tentatives, signe les sessions dans un cookie sécurisé et protège toutes les actions de lecture et d’écriture ;
- Apps Script relit l’autorisation dans l’annuaire à chaque action et écrit dans les feuilles et documents Google ;
- les situations sont enregistrées dans l’onglet `Situations sécurisées`, sans formulaire Google public.

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

L’ordre de publication est impératif : Apps Script, puis le Worker et son domaine personnalisé, puis le site statique. Les valeurs `API_KEY`, `APPS_SCRIPT_KEY`, `APPS_SCRIPT_URL` et `SESSION_SECRET` restent dans les propriétés ou secrets des services et ne sont jamais versionnées.
