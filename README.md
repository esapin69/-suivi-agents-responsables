# Suivi des agents responsables

Portail interne publié sur `responsable.esapin.com`. Le suivi des stagiaires brancardiers repose désormais sur un moteur Cloudflare autonome ; Google Apps Script n’est pas utilisé par ce nouveau module.

## Suivi des stagiaires

Le module couvre le cycle complet :

- création rapide de la fiche à l’arrivée ;
- sauvegarde durable et réouverture à tout moment ;
- observations personnelles de plusieurs agents ;
- signature limitée au témoignage réellement rédigé par chaque agent ;
- lien privé, révocable et temporaire pour le stagiaire ;
- partie propre au stagiaire et signature ;
- évaluation finale sur les six critères attendus ;
- clôture réservée aux administrateurs et chefs ;
- PDF définitif institutionnel archivé dans un espace privé ;
- nouvelle version obligatoire après clôture, sans remplacement du document signé ;
- journal d’audit non modifiable.

## Architecture minimale

| Élément | Rôle |
|---|---|
| Site statique GitHub Pages | Écrans de l’équipe et du stagiaire |
| Un Worker Cloudflare | Authentification, règles métier, génération des PDF et API |
| Une base Cloudflare D1 | Fiches, utilisateurs, observations, versions et audit |
| Un bucket Cloudflare R2 privé | Images de signature et PDF définitifs |
| GitHub | Source unique, historique, tests et déclenchement du déploiement |

Le fichier [`cloudflare/wrangler.jsonc`](cloudflare/wrangler.jsonc) est la source de vérité du Worker. Le moteur unique reste dans ce dossier, qui correspond au branchement Workers Builds déjà en place. D1 et R2 sont déclarés sans identifiant : Wrangler peut les créer automatiquement lors du premier déploiement connecté à GitHub. Le schéma D1 s’initialise ensuite automatiquement et de manière idempotente depuis la migration versionnée.

Le dossier Google Drive existant peut rester un espace d’export ou de consultation. Il n’est ni la base de données ni une dépendance du fonctionnement quotidien. Le dossier `Formule 1 officielle modèle` étant actuellement vide, le PDF utilise la présentation institutionnelle GHE incluse dans le code ; un futur modèle pourra la remplacer sans modifier les anciens PDF.

## Transition sans coupure

Les rubriques historiques de suivi des nouveaux agents continuent temporairement à utiliser Apps Script. Le Worker conserve donc une passerelle de compatibilité uniquement pour ces anciennes actions.

Lorsqu’une personne déjà autorisée se reconnecte, son identité est copiée de façon sécurisée dans D1. Un administrateur peut ensuite gérer les accès du module stagiaires directement sur le site. Aucun code personnel n’est stocké en clair.

La passerelle historique pourra être retirée lorsque les autres rubriques auront été migrées et vérifiées. Cette suppression fera l’objet d’une version distincte afin d’éviter toute coupure.

## Sécurité et intégrité

- Cookies `HttpOnly`, `Secure` et `SameSite=Strict`.
- Origine web autorisée explicitement.
- Limitation des tentatives de connexion et d’échange de liens.
- Codes protégés par HMAC pour la recherche et PBKDF2 avec sel pour la vérification.
- Jetons de partage stockés uniquement sous forme d’empreinte.
- Objets R2 privés, servis seulement après contrôle d’accès.
- Empreinte SHA-256 des signatures et de chaque PDF.
- Verrous SQL empêchant la modification ou la suppression des signatures, documents et événements d’audit.
- Une observation signée, la partie stagiaire signée et l’évaluation finale signée deviennent immuables.
- Aucun secret, code d’accès ou donnée de production dans GitHub.

## Vérifications

```bash
npm ci
npm run typecheck
npm test
npm run types
```

Ces commandes sont à exécuter dans le dossier `cloudflare`.

Les tests couvrent notamment : initialisation d’une D1 vide, création d’un administrateur, connexion, création d’une fiche, lien stagiaire, sauvegarde, signatures multiples, refus de modifier une observation signée, clôture, génération et lecture du PDF, puis ouverture d’une nouvelle version.

## Déploiement

1. Les changements sont préparés dans une branche et une pull request brouillon.
2. Les tests et le build Cloudflare doivent réussir.
3. Après validation explicite, la pull request est fusionnée dans `main`.
4. GitHub Pages publie le site et Workers Builds déploie le Worker `suivi-agents-responsables`.
5. Le premier appel au nouveau module initialise automatiquement le schéma D1.

Secrets Cloudflare :

- `SESSION_SECRET` — obligatoire, déjà utilisé pour les sessions ;
- `APPS_SCRIPT_URL` et `APPS_SCRIPT_KEY` — conservés uniquement pendant la transition des anciennes rubriques ;
- `BOOTSTRAP_TOKEN` — facultatif, réservé à une initialisation de secours lorsqu’aucun compte ni passerelle historique n’est disponible.

Avant la mise en production avec de vraies données, le responsable doit fixer la durée de conservation des dossiers et confirmer les personnes ayant le rôle `CHEF`.
