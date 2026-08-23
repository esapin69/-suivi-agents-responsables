# STIP — moteur d’intelligence opérationnelle

## Invariants

- Une donnée n’est pas une alerte.
- Un écart entre shifts n’est pas une anomalie à lui seul.
- Une alerte doit expliquer immédiatement : **quoi, quand, impact concret, pourquoi agir**.
- Une recommandation n’est produite que si l’amélioration attendue est démontrable avec les données disponibles.
- Normal = silencieux/compact ; anomalie = visible ; action utile = mise en avant ; urgence = prioritaire.
- Les URL d’abonnement calendrier sont permanentes : le contenu évolue derrière l’URL, le token n’est pas recréé.

## Sources actuellement reliées

- `agents`
- `planning`
- `formations`
- `stagiaires`
- `stip_change_requests`
- `inaptitudes`
- `stip_operational_baselines`
- `stip_operational_signals`
- `stip_operational_decisions`

## Shifts canoniques

- M — 06:50–14:40
- J — 08:30–16:20
- J4 — 10:10–18:00
- S — 13:30–21:00
- N — 21:00–06:50

Les variantes (`M0130`, `M0131`, `M0177`, `J0464`, codes suffixés `*`, etc.) doivent être normalisées avant tout calcul. Les repos/absences ne sont jamais comptés comme présence.

## Baselines

`stip_operational_baselines` conserve, par jour de semaine et shift, la médiane et le premier quartile des effectifs observés sur l’historique récent. Ces valeurs sont du contexte, pas des seuils automatiques d’alerte.

Un effectif sous l’habitude ne suffit pas à déclencher une alerte. Il faut une conséquence opérationnelle identifiable.

## Signaux fiables actuellement

- participant à une formation non retrouvé / non planifié en travail ;
- formations simultanées incompatibles pour un même agent ;
- trou réel de couverture d’un stagiaire ;
- référent non disponible sur le planning ;
- même référent attribué simultanément à plusieurs stagiaires.

Les informations administratives comme « lieu de formation non renseigné » restent dans le descriptif de l’événement mais ne deviennent pas un signal opérationnel.

## Changements de planning

Seules les demandes encore actives peuvent influencer une analyse prospective. Une demande refusée/annulée/terminée est historique et ne modifie pas l’état opérationnel projeté. Une demande acceptée mais pas encore reflétée dans le planning doit être explicitement identifiée avant toute simulation.

## Contraintes / inaptitudes

Les contraintes sont prises en compte uniquement lorsqu’elles existent réellement dans `inaptitudes`, sont actives sur la date étudiée et peuvent être reliées à un agent. L’absence actuelle de données ne doit jamais être interprétée comme « aucune contrainte humaine n’existe » ; elle signifie seulement « STIP n’a pas de contrainte structurée exploitable ».

## Chefs

La présence des chefs peut être calculée depuis `agents.equipe = 'chefs'` + `planning`. L’absence d’un chef ne devient pas automatiquement une alerte : la pertinence dépend du créneau et des règles de service, qui doivent être démontrées avant automatisation.

## Recommandations de rééquilibrage

Suspendues tant que le moteur ne peut pas démontrer simultanément :

1. un déficit réel sur le créneau cible ;
2. une marge réelle sur le shift donneur ;
3. la compatibilité horaire ;
4. l’absence de formation/stagiaire/conflit connu pour le candidat ;
5. les contraintes/compétences/sectorisation nécessaires lorsqu’elles sont structurées ;
6. l’effet avant/après ;
7. un minimum d’équité à partir de l’historique des décisions/mouvements.

Le rendu attendu est explicite : effectif prévu → indisponibilités → effectif réel → référence habituelle → conséquence → option → effet de l’option.

## Mémoire

`stip_operational_decisions` conserve la décision humaine. L’historique est un indice pour les futures recommandations, jamais une autorisation à répéter automatiquement une décision.

## Données encore non structurées

La sectorisation détaillée, les autorisations Mère-Enfant et les compétences opérationnelles ne disposent pas encore d’une source structurée fiable identifiée dans la base actuelle. Le moteur doit donc s’abstenir de recommandations qui en dépendent au lieu de les inventer.
