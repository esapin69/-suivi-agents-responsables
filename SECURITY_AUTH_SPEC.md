# Authentification responsables — contrat serveur V1

Cette branche prépare le front. Ne pas fusionner dans `main` tant que le Worker n’implémente pas ce contrat.

## Source d’identité
Le fichier Google Sheets privé `16pJDUJvVaozQR3yRCQW7lJ2J_eD797AFvvYCSAp--8c` contient les colonnes `ID responsable` et `Code d’accès`.
Seules les lignes ayant un `ID responsable` non vide sont autorisées à se connecter.

## Endpoints obligatoires

### POST /auth/login
Entrée JSON : `{ "code": "000001" }`
- Valider exactement 6 chiffres.
- Rechercher le code côté serveur dans la source privée.
- Ne jamais renvoyer le code au navigateur.
- En cas de succès, créer un token de session aléatoire et opaque, durée recommandée 30 jours.
- Stocker/valider la session côté serveur.
- Cookie recommandé : `resp_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`.
- Réponse : `{ "ok": true, "user": { "id_responsable": "...", "nom": "...", "prenom": "...", "poste": "..." } }`.
- Code faux : HTTP 401 générique, sans révéler si un responsable existe.
- Ajouter limitation des tentatives par IP + fenêtre temporelle.

### GET /auth/me
- Lire et valider le cookie `resp_session`.
- Session invalide/expirée : 401.
- Réponse identique au bloc `user` ci-dessus, sans code d’accès.

### POST /auth/logout
- Invalider la session côté serveur et expirer le cookie.
- Réponse `{ "ok": true }`.

## Protection de toutes les actions API
Toutes les actions existantes (`listAgents`, `getAgent`, `createAgent`, `updateAgent`, `listDirectory`, `listEvaluations`, `getEvaluation`, `saveEvaluationDraft`, `finalizeEvaluation`, etc.) doivent exiger une session valide AVANT traitement.

Le serveur doit IGNORER toute identité déclarée par le navigateur. Pour chaque écriture :
- dériver `id_responsable`, nom/prénom et identité évaluateur depuis la session ;
- enregistrer cette identité dans les données/journaux ;
- ne jamais faire confiance à `evaluateur`, `signature`, `id_responsable` reçus du client pour déterminer l’auteur.

## Évaluations
`evaluateur` doit être fixé côté serveur à partir de la session. Le navigateur peut l’afficher mais pas choisir une autre personne.
La signature graphique du responsable reste une preuve graphique distincte ; son auteur administratif vient de la session.

## Situations / événements
Le formulaire ne doit plus envoyer directement vers Google Forms depuis le navigateur. Créer une action API serveur (ex. `createSituation`) qui :
- exige la session ;
- reçoit l’agent + impact + contexte + conséquence + fait ;
- ajoute automatiquement l’auteur connecté ;
- écrit dans la destination choisie côté serveur.

## CORS
Si le front et l’API sont sur deux origines :
- `Access-Control-Allow-Origin` doit être la valeur exacte de l’origine du site, jamais `*` avec cookies ;
- `Access-Control-Allow-Credentials: true` ;
- gérer `OPTIONS` ;
- autoriser `Content-Type`.

## Règle de publication
1. Déployer le Worker sécurisé.
2. Tester login, `/auth/me`, logout et rejet 401 des API sans session.
3. Tester que l’identité écrite correspond toujours au code connecté.
4. Seulement ensuite fusionner `auth-responsables-v1` dans `main`.
