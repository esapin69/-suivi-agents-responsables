# Suivi des agents responsables

Portail interne publié sur `responsable.esapin.com`.

## Décision d’architecture

L’architecture cible validée pour l’ensemble du site est unique :

- **GitHub** est la source unique du code, de l’historique et des validations ;
- **Cloudflare Workers** exécute les sessions, les règles métier, l’API et la génération des documents ;
- **Cloudflare D1** conserve les données structurées ;
- **Cloudflare R2 privé** conserve les signatures, PDF et autres fichiers ;
- le Google Sheet **Annuaire** reste, pendant la transition, l’unique autorité des codes à six chiffres et des droits matérialisés par `OK` ;
- **Google Drive** peut recevoir une copie ou un export pour les autres données ;
- **Google Apps Script** reste la passerelle contrôlée vers l’Annuaire et vers les anciennes rubriques qui n’ont pas encore été migrées.

Aucune nouvelle logique métier de suivi des stagiaires ne doit être créée dans Apps Script. La passerelle d’authentification existante est maintenue tant qu’une migration explicite de l’Annuaire n’a pas été décidée et testée.

## Règles pour toute future modification

1. Préparer les changements dans une branche et une pull request.
2. Utiliser Cloudflare pour toute nouvelle fonction du site.
3. Réutiliser le Worker, D1 et R2 existants avant d’envisager un nouveau service.
4. Tester les anciennes et les nouvelles fonctions concernées avant toute fusion.
5. Ne jamais fusionner dans `main` ni mettre volontairement en production sans validation explicite d’Eddy.
6. Ne jamais stocker de secret, code d’accès ou donnée de production dans GitHub.
7. Migrer une ancienne rubrique avant de retirer son équivalent Apps Script.

Le fonctionnement de référence est : **demande → branche GitHub → tests → validation explicite → fusion → déploiement Cloudflare**.

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
| Un Worker Cloudflare | Sessions, contrôle des droits relus dans l’Annuaire, règles métier, génération des PDF et API |
| Une base Cloudflare D1 | Fiches, miroir technique des identités, observations, versions et audit |
| Un bucket Cloudflare R2 privé | Images de signature et PDF définitifs |
| GitHub | Source unique, historique, tests et déclenchement du déploiement |

Le fichier [`cloudflare/wrangler.jsonc`](cloudflare/wrangler.jsonc) est la source de vérité du Worker. Le moteur unique reste dans ce dossier, qui correspond au branchement Workers Builds déjà en place. D1 et R2 sont déclarés sans identifiant : Wrangler peut les créer automatiquement lors du premier déploiement connecté à GitHub. Le schéma D1 s’initialise ensuite automatiquement et de manière idempotente depuis la migration versionnée.

Le dossier Google Drive existant peut rester un espace d’export ou de consultation pour les dossiers stagiaires. Seul l’onglet `Annuaire` reste consulté pour les accès du personnel. Le dossier `Formule 1 officielle modèle` étant actuellement vide, le PDF utilise la présentation institutionnelle GHE incluse dans le code ; un futur modèle pourra la remplacer sans modifier les anciens PDF.

## Transition sans coupure

Les rubriques historiques de suivi des nouveaux agents continuent temporairement à utiliser Apps Script. Le Worker conserve donc une passerelle de compatibilité uniquement pour ces anciennes actions.

À chaque connexion, le Worker fait vérifier le code directement dans l’Annuaire. À chaque nouvelle requête authentifiée, il relit l’état actuel des colonnes `OK`. D1 ne reçoit qu’un miroir technique de l’identité utile pour attribuer les observations et les signatures : aucun code, aucun mot de passe et aucun droit modifiable séparément n’y sont stockés. Les accès continuent donc à être gérés exactement dans l’onglet `Annuaire`.

Chaque ancienne rubrique devra être migrée et vérifiée séparément. La suppression finale de la passerelle historique fera l’objet d’une version distincte afin d’éviter toute coupure.

## Sécurité et intégrité

- Cookies `HttpOnly`, `Secure` et `SameSite=Strict`.
- Origine web autorisée explicitement.
- Limitation des tentatives de connexion et d’échange de liens.
- Codes du personnel vérifiés uniquement par la passerelle Annuaire et jamais copiés dans D1.
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

Les tests couvrent notamment : initialisation d’une D1 sans codes du personnel, connexion par l’Annuaire, application immédiate d’un `OK` retiré, invalidation après changement de code, création d’une fiche, lien stagiaire, sauvegarde, signatures multiples, refus de modifier une observation signée, clôture, génération et lecture du PDF, puis ouverture d’une nouvelle version.

## Déploiement

1. Les changements sont préparés dans une branche et une pull request brouillon.
2. Les tests et le build Cloudflare doivent réussir.
3. Après validation explicite, la pull request est fusionnée dans `main`.
4. GitHub Pages publie le site et Workers Builds déploie le Worker `suivi-agents-responsables`.
5. Le premier appel au nouveau module initialise automatiquement le schéma D1.

Secrets Cloudflare :

- `SESSION_SECRET` — obligatoire, déjà utilisé pour les sessions ;
- `APPS_SCRIPT_URL` et `APPS_SCRIPT_KEY` — nécessaires pour vérifier les codes et relire les droits de l’Annuaire pendant la transition.

Avant la mise en production avec de vraies données, le responsable doit fixer la durée de conservation des dossiers et confirmer les personnes ayant le rôle `CHEF`.
