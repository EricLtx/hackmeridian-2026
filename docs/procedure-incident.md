# Procédure d'incident

Ce document dit qui agit, comment et dans quel délai quand la surveillance d'Open Window lève une alerte. Il complète le plan de monitoring de [modele-menace-stride.md](modele-menace-stride.md), section 3.1, et les décisions S6, S7 et S17 de [securite.md](securite.md). Version du 14 octobre 2026, déploiement testnet.

## 1. Rôles

| Rôle | Détient | Peut | Ne peut pas |
|---|---|---|---|
| Responsable d'incident | La décision | Déclarer l'incident, choisir l'action, communiquer | Agir seul sur une clé qu'il ne détient pas |
| Gardien | La clé `guardian` | Suspendre les entrées (`pause`) | Lever la pause ; bloquer une sortie |
| Gouverneur | La clé `governor` (multisig avant tout dépôt réel) | Lever la pause, retirer un fonds, mettre à niveau | Toucher une pension ouverte |
| Intendant d'un fonds | La clé du fonds | Geler son fonds, révoquer un prêteur, abaisser la référence | Agir sur un autre fonds |
| Opérateur de prix | La clé du flux NAV | Republier une valeur liquidative | Modifier le contrat |

Règle : la pause est le premier geste, parce qu'elle ne bloque jamais une sortie. Rachat, retrait de la part non prêtée et saisie à l'échéance restent disponibles pendant tout l'incident.

## 2. Détection

La surveillance tourne en continu :

```sh
cd demo
npm run monitor -- --watch --act
```

Une passe toutes les 30 secondes. `--act` pose la pause sur une alerte critique de prix ou de rapprochement, et prolonge les entrées proches de l'archivage. Chaque alerte est ajoutée à `demo/.state/alerts.jsonl`.

| Niveau | Délai de réaction | Exemples |
|---|---|---|
| Critique | Pause automatique, responsable joint en 15 minutes | Prix refusé par le contrat, écart de rapprochement des parts (I2), code du contrat modifié, entrée archivée |
| Avertissement | Examen dans l'heure | Changement privilégié, pause en cours, plafond utilisé à 80 %, NAV de plus de 24 heures, entrée à moins de 14 jours de l'archivage |

## 3. Conduite à tenir par alerte

| Alerte | Cause probable | Action immédiate | Retour à la normale |
|---|---|---|---|
| Prix refusé (`PriceOutOfBand`, `StalePrice`) | Flux NAV faux ou muet ; change hors bande | Pause par le gardien | L'opérateur republie la bonne valeur ; si le change a dérivé durablement, nouvelle admission à deux clés ; puis levée de pause par le gouverneur |
| Écart de rapprochement (I2) | Gel ou reprise des parts par l'émetteur ; bogue | Pause ; contacter l'émetteur | Écart expliqué et soldé ; décision S9 si des pensions sont touchées |
| Code modifié | Mise à niveau attendue ou clé compromise | Si la mise à niveau n'est pas annoncée : pause, révocation des signataires du multisig | Revue du WASM déployé contre le code publié |
| Changement privilégié | Opération d'administration | Un second signataire vérifie qu'elle était prévue | Aucun si prévue ; sinon traiter comme une compromission de clé |
| Entrée proche de l'archivage | TTL non prolongé | Prolongation (automatique avec `--act`) | Entrée revenue au-dessus du seuil |
| Plafond à 80 % ou rythme anormal d'ouvertures | Usage réel ou sondage | Examen ; pause si inexpliqué | Plafonds revus par l'intendant ou le gouverneur |

Commandes utiles, depuis `demo/` :

```sh
npm run status                    # état du contrat vu par la démonstration
npm run demo -- --only=repair     # lève la pause, republie la NAV, solde la pension de démonstration
npm run setup -- --fx=local       # bascule sur le flux de change de secours (nouvelle admission)
```

## 4. Communication

- **Dans l'heure** suivant une alerte critique : message public sur le dépôt (issue épinglée) qui dit ce qui est suspendu, ce qui reste ouvert (rachat, retrait, saisie), et quand viendra la prochaine information.
- **Sous 48 heures** : rapport préliminaire, conformément aux standards DeFi de la SDF repris en section 6.2 de [securite.md](securite.md).
- **Après résolution** : post-mortem public, avec la chronologie, la cause, l'action et la correction, et l'ajout du problème au modèle STRIDE s'il était nouveau.
- **Émetteurs régulés** : l'information nécessaire à leurs propres obligations de notification d'incident est fournie sans délai (section 6.3 de [securite.md](securite.md)).

## 5. Exercices

La répétition rejoue chaque détecteur avec un déclencheur réel sur testnet, prend l'action et restaure l'état :

```sh
npm run monitor -- --rehearse
```

Répétition du 14 octobre 2026 :

| Détecteur | Menace | Déclencheur | Alerte | Action | Restauré |
|---|---|---|---|---|---|
| Prix | Tamper.1 | NAV publiée 3 % trop haut | oui, critique | pause par le gardien en 1,9 s | oui |
| Rapprochement | DoS.5 | Reprise d'une unité de part par l'émetteur | oui, critique | pause par le gardien en 6,4 s | oui |
| Changement privilégié | Elev.2 | `set_guardian` par le gouverneur | oui | vérification par un second signataire, manuelle | oui |
| Exposition | DoS.1 | Plafond du fonds abaissé à 90 % d'utilisation | oui | plafonds revus et rétablis | oui |
| Pause | DoS.4 | Pause par le gardien | oui | levée par le gouverneur | oui |
| Archivage | DoS.2 | Seuil forcé à 130 jours : aucune entrée n'approche réellement l'archivage | oui | 6 entrées prolongées à environ 140 jours en 2,1 s | oui |
| Événements | Repud.1 | Aucun déclencheur réel possible : chaque pension émet son événement | non, vérification passée | aucune | sans objet |

Rythme : une répétition complète avant chaque démonstration publique et chaque mise à niveau, puis une par mois en exploitation.

## 6. Limites connues

- La pause automatique utilise la clé du gardien sur la machine de surveillance : avant tout dépôt réel, cette clé doit être isolée et limitée à la pause, ce qu'elle est déjà dans le contrat.
- La surveillance lit l'historique d'événements du RPC public, conservé environ sept jours : un indexeur dédié est prévu à l'étape 1 de la [feuille de route](roadmap.md).
- Le détecteur de rapprochement couvre un fonds ; il s'étend fonds par fonds quand d'autres fonds sont admis.
