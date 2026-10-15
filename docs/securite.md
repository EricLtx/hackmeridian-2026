# Bases de cybersécurité du contrat Open Window (crate `night-window`)

Date : 6 octobre 2026, révisé le 13 octobre 2026 · Statut : **décisions de cadrage prises (S1 à S19, DORA D1 et D2), à formaliser dans la spécification puis à implémenter** · Référence métier : l'étude de cadrage interne, conservée hors du dépôt public · Modèle de menace STRIDE : [modele-menace-stride.md](modele-menace-stride.md)

Ce document fixe ce qui est déjà en place dans le code et la chaîne d'outils, ce que la spécification devra trancher, et les règles de revue qui s'appliquent à chaque évolution du contrat. Il suit la grille de revue du skill officiel `stellar-dev` (fichier `security.md`), appliquée au cas d'une mise en pension.

---

## 1. Ce qu'il faut protéger

| Actif | Où il vit | Qui peut le perdre |
|---|---|---|
| Stablecoins déposés dans les offres | Solde du contrat, ventilé par entrée `Offer(id)` | Prêteurs |
| Parts de fonds bloquées en pension | Solde du contrat, ventilé par entrée `Repo(id)` | Emprunteurs |
| Registre des fonds acceptés (oracle, décote) | Entrées `Fund(adresse)` | Tous : un mauvais oracle ou une décote nulle permet d'emprunter plus que la valeur des parts |
| Clé d'administration | Entrée `Admin` (stockage d'instance) | Tous : l'admin change le registre et le code |
| Code du contrat | WASM référencé par l'instance | Tous : une mise à niveau malveillante vide le contrat |

Le contrat est **porteur de valeur** dès qu'une offre est déposée. Les exigences de la section 6 (pause, gouvernance de l'admin) s'appliquent avant tout dépôt réel, pas seulement avant le mainnet.

## 2. Modèle de menace

### 2.1 Ce que l'attaquant contrôle

Hypothèses standard de la plateforme, reprises telles quelles :

- tous les arguments passés aux fonctions du contrat ;
- l'ordre et le moment des transactions (il voit une offre arriver et peut la prendre ou la devancer) ;
- tous les comptes sauf ceux dont il n'a pas la signature ;
- le déploiement de contrats qui imitent une interface (un faux oracle SEP-40, un faux token SEP-41) ;
- la forme de l'état on-chain qu'il peut créer légalement : nombre d'entrées, et même le TTL de **nos** entrées, qu'il peut prolonger.

### 2.2 Acteurs et confiance accordée

| Acteur | Confiance | Conséquence pour le contrat |
|---|---|---|
| Emprunteur | Aucune | Chaque fonction qu'il appelle vérifie son `require_auth` et ses bornes |
| Prêteur | Aucune | Idem ; une offre ne peut être retirée que par son auteur et seulement pour la part non prêtée |
| Administrateur | Élevée, à encadrer | Il choisit les oracles, les décotes et le code. La section 6 propose de l'encadrer (multisig, délai) |
| Émetteur du fonds | Externe, subie | Les parts sont des tokens à permissions : token Soroban à permissions ou actif classique à autorisation, selon l'émetteur. L'émetteur peut geler ou reprendre un solde, y compris celui du contrat |
| Oracle SEP-40 | Allowlisté par l'admin | Son prix est une donnée externe : fraîcheur et bornes à vérifier à chaque lecture |
| Hôte Soroban | Totale | Fournit l'auth, bloque la réentrance, mesure les ressources |

### 2.3 Ce que la plateforme garantit

- Pas de `delegatecall` : aucun code étranger ne s'exécute dans le contexte du contrat.
- Pas de réentrance : l'hôte bloque les appels réentrants, directs ou indirects. Les appels externes restent des frontières d'échec et de budget ; l'ordre des écritures reste à soigner.
- Protection contre le rejeu des autorisations : nonces et expirations sont gérés par l'hôte.
- L'autorisation est **explicite et optionnelle** : l'oubli d'un `require_auth` est la faille à chercher en priorité.

## 3. Invariants du contrat

Ces invariants sont la base des tests de propriété et de la revue. Ils sont écrits ici en langage courant ; la spécification les formalisera.

| # | Invariant | État |
|---|---|---|
| I1 | Le solde en stablecoins du contrat est au moins égal à la somme des montants disponibles de toutes les offres | À implémenter avec le cycle de vie |
| I2 | Chaque part bloquée appartient à exactement une pension ouverte ; le solde en parts du contrat pour un fonds est au moins égal à la somme des parts des pensions ouvertes sur ce fonds | À implémenter |
| I3 | À l'ouverture, principal ≤ valeur des parts × (1 − décote), avec un prix non périmé | À spécifier (section 6) |
| I4 | Avant l'échéance, seul l'emprunteur peut clôturer la pension (rachat). Après l'échéance, le rachat reste possible tant que la saisie n'a pas eu lieu, et seul le prêteur peut saisir | À spécifier |
| I5 | Une pension change d'état une seule fois : `Open` → `Repurchased` ou `Open` → `Defaulted`. Aucun retour en arrière | Types en place, logique à implémenter |
| I6 | Aucune fonction ne parcourt l'ensemble des offres ou des pensions ; chaque appel touche un nombre borné d'entrées | **En place par construction** : clés `Offer(u64)` et `Repo(u64)` individuelles, aucun index global |
| I7 | Seul l'admin modifie le registre, la durée maximale, l'admin et le code | **En place** : `require_admin` charge l'admin depuis le stockage, jamais depuis un argument |
| I8 | Les codes d'erreur et les variantes de types exportés ne sont jamais renumérotés ni remodelés ; on ajoute | **En place** comme règle (commentaire dans `lib.rs`, AGENTS.md) |
| I9 | Les conditions d'une pension (taux, échéance, décote appliquée) sont figées à l'ouverture ; retirer un fonds du registre ou changer sa décote n'affecte pas les pensions ouvertes | Documenté dans `remove_fund`, à garantir dans `open_repo` |

## 4. Classes de vulnérabilité appliquées à Open Window

| Classe | Risque pour ce contrat | Réponse |
|---|---|---|
| 1. Autorisation manquante | Retrait d'une offre par un tiers, saisie par un non-prêteur, changement d'oracle par un non-admin | En place pour l'admin (`require_admin`). À faire pour chaque `Address` du cycle de vie : `lender` sur `create_offer` et `withdraw_offer`, `borrower` sur `open_repo` et `repurchase`, prêteur chargé depuis `Repo` sur `seize` |
| 2. Rejeu d'autorisation via intermédiaire | `open_repo` fera un `transfer` de parts au nom de l'emprunteur. Sans `require_auth` de l'emprunteur **dans `open_repo` lui-même**, quiconque peut consommer une autorisation pré-signée | Règle : chaque couche qui exerce l'autorité d'une adresse la ré-authentifie. Test obligatoire avec `mock_auths` ciblé et vérification de l'arbre `env.auths()` |
| 3. Réinitialisation | Capture de l'admin par un second `initialize` | **Écartée** : constructeur `__constructor`, pas de fonction `initialize` |
| 4. Appel de contrat arbitraire | Faux oracle, faux token de parts, stablecoin exotique | Fonds et oracles **allowlistés** par l'admin (registre). Stablecoins des offres : à allowlister aussi (section 6) |
| 5. Débordement arithmétique | Calcul d'intérêt (`principal × taux × durée`), conversion prix × parts avec décimales | Lint `clippy::arithmetic_side_effects` en `deny` : toute opération doit passer par `checked_*` ou `saturating_*` et renvoyer une erreur typée. `overflow-checks = true` en release **et** en test. Montants `i128` : refuser `≤ 0` à l'entrée |
| 6. Collision de clés | Écrasement d'une offre par une pension | **Écartée** : énumération `DataKey` typée ; noms de types uniques dans le crate |
| 7. Course vérifier-puis-agir | Le prêteur retire son offre entre la simulation et l'exécution d'un `open_repo` ; prix qui bouge entre deux ledgers | Vérifications et écritures dans la même invocation ; l'emprunteur passe des bornes (`principal` demandé, durée) et le contrat refuse plutôt que d'ajuster en silence |
| 8. TTL et archivage | Une pension archivée bloque le rachat ou la saisie ; un TTL utilisé comme échéance | L'échéance est **stockée dans la valeur** (`Repo.maturity`) et comparée au `ledger().timestamp()`, jamais déduite du TTL. TTL des entrées `Fund`, `Offer`, `Repo` prolongé à chaque écriture ; TTL d'instance prolongé sur les chemins admin |
| 9. Confiance dans une valeur externe | Prix périmé, prix nul ou aberrant, oracle qui renvoie `None` | `fund_price` renvoie une erreur typée sur `None`. **À spécifier** : fenêtre de fraîcheur (`PriceData.timestamp` contre l'horloge du ledger), bornes de variation, comportement si le prix est indisponible le week-end |
| 10. Épuisement de ressources | Liste de fonds acceptés d'une offre trop longue ; parcours de positions | I6. **À spécifier** : plafond sur `Offer.funds` (par exemple 8 adresses) |
| 11. Comptes personnalisés | Non concerné : le contrat n'implémente pas `__check_auth` | — |

### Revue « consommateur de tokens », spécifique aux parts de fonds

| Point | Réponse |
|---|---|
| Tokens acceptés | Allowlistés : parts via le registre ; stablecoins à allowlister (section 6) |
| Décimales | À interroger et stocker à l'enregistrement du fonds (`decimals()` du token et de l'oracle) ; ne jamais supposer 7 |
| Montant reçu après `transfer` | Pour des tokens à permissions, vérifier le solde avant et après le transfert dans `open_repo` et `create_offer` plutôt que faire confiance au montant demandé |
| Particularités SAC et tokens à permissions | **Le risque propre à ce projet.** Si l'émetteur gèle le solde du contrat ou reprend les parts (clawback), le rachat devient impossible et l'emprunteur perd ses parts sans faute de sa part. Si le prêteur n'est pas autorisé à détenir les parts, la saisie échoue. Le cadrage note ce point ; la spécification doit décider : rachat du fonds par le contrat, vente à un tiers autorisé, ou prêteurs eux-mêmes autorisés par l'émetteur |
| Flux `transfer_from` | Non prévu : les transferts se font par `transfer` avec l'autorisation de l'adresse concernée dans la même transaction |
| Événements standard | Les tokens émettent les leurs ; le contrat émettra ses propres événements de cycle de vie (offre créée, pension ouverte, rachetée, saisie, retrait) |

## 5. Contrôles déjà en place dans le code

État au 14 octobre 2026, cycle de vie complet implémenté.

- **Initialisation.** Constructeur atomique avec le gouverneur, qui est aussi le premier gardien ; pas de fenêtre d'initialisation.
- **Rôles.** Chaque fonction privilégiée charge son rôle depuis le stockage et appelle `require_auth` dessus : gouverneur (registre, enveloppe de risque, plafonds par devise, mise à niveau, levée de pause), gardien (pause des entrées), intendant de chaque fonds (prêteurs approuvés, réglages dans l'enveloppe, gel du fonds, abaissement de la référence). Transfert du gouverneur en deux temps. Admission d'un fonds signée par le gouverneur et l'intendant dans le même appel.
- **Autorité des parties.** `require_auth` sur le prêteur dans `create_offer` et `withdraw_offer`, sur l'emprunteur dans `open_repo` ; dans `repurchase` et `seize`, l'adresse est chargée depuis la pension stockée, jamais prise en argument.
- **Prix.** Oracles lus uniquement depuis le registre ; fraîcheur et horodatage futur refusés ; corridor fondé sur un modèle (S2) ; prix croisé avec bande et décote de change propres ; référence qui ne baisse jamais et ne monte qu'au rythme du modèle.
- **Bornes.** Décotes strictement inférieures à 100 % (type `Bps`) ; enveloppe de risque bornant chaque réglage d'intendant ; plafonds par pension, par fonds et par devise ; durée d'une heure à 30 jours ; huit fonds au plus par offre.
- **Transferts.** Chaque entrée de jetons est vérifiée par le solde avant et après (`TransferMismatch` sinon).
- **Pause.** Seuls `create_offer` et `open_repo` la consultent ; `repurchase`, `withdraw_offer` et `seize` restent toujours disponibles.
- **Stockage.** Clés typées, une entrée par fonds, offre et pension ; TTL prolongé à chaque écriture (seuil 30 jours, prolongation à 120 jours) ; échéances en horodatage.
- **Erreurs et événements.** 30 erreurs typées, aucun `unwrap` ni `panic!` (lints `deny`) ; un événement par changement d'état.
- **Tests.** 63 tests pour le contrat : intrus refusé sur chaque fonction privilégiée, arbres `env.auths()` vérifiés, événements comparés en XDR, chaque chemin d'erreur, invariants vérifiés après 300 opérations aléatoires, empreinte constante de `open_repo` (17 entrées lues, 9 écrites), cycle complet avec un vrai jeton à liste blanche et un vrai flux de prix.

## 6. Décisions prises au cadrage (13 octobre 2026)

Chaque décision ci-dessous a été prise lors du peaufinement du cadrage, sur la base de faits vérifiés : code des contrats d'émetteurs régulés déjà déployés sur Stellar, documentation du réseau, incidents publics, standards de sécurité DeFi publiés par la SDF le 20 juillet 2026, appel à contributions de l'ESMA du 9 octobre 2026. La spécification les formalise ; chaque point devra avoir un test.

| # | Sujet | Décision |
|---|---|---|
| S1 | Fraîcheur du prix | Le prix lu doit porter un `timestamp` d'au plus N heures ; N est un paramètre du registre, par fonds, fixé pour couvrir un week-end si le flux ne publie pas le samedi. Prix absent ou périmé : refus (`Error::NoPrice`, nouvelle erreur `StalePrice`), jamais d'ajustement silencieux. **Version 3** : un flux de secours par fonds, admis à deux clés après le délai, remplace un flux principal périmé ou en échec ; quand les deux sont frais, ils doivent concorder à `max_divergence_bps` près (au plus le plancher du corridor), sinon `PriceDivergence`. Un secours frais mais invalide fait échouer le calcul (refus par défaut), un secours périmé est ignoré ; son âge maximal est plafonné par celui de la valeur liquidative du fonds |
| S2 | Bornes du prix | **Corridor fondé sur un modèle**, et non une déviation relative au prix précédent. Une part de fonds capitalisant suit une trajectoire prévisible : la valeur liquidative lue doit être comprise entre `référence × (1 − plancher)` et `référence × (1 + plancher + rendement_max × durée / an)`. La référence ne suit pas l'oracle : elle ne baisse jamais et monte au plus le long du modèle (`model_path`), n'importe qui pouvant l'avancer ; l'intendant peut seulement l'abaisser. Un flux défaillant ne peut donc pas la faire dériver, même en publiant à chaque registre (constat H1 de la revue du 14 octobre 2026, test dédié). Le change d'un prix croisé a sa propre bande autour d'une référence fixée à l'admission à deux clés. L'incident YieldBlox du 22 février 2026 (10,2 M$) a contourné un contrôle de déviation relative parce que les deux fenêtres comparées étaient déjà manipulées |
| S3 | Intérêt et arrondis | `principal × taux_bps × durée / (10 000 × 365 × 86 400)` en `i128` vérifié, arrondi en faveur du prêteur. **Amendé le 14 octobre 2026** : la durée compte par heure entamée, une heure au moins, et l'intérêt continue de courir après l'échéance jusqu'au rachat ou à la saisie (décision Q2 : le retard n'est pas gratuit). L'heure entamée rend le montant signé par l'emprunteur stable entre la simulation et l'exécution de sa transaction. Principal et intérêt reviennent dans l'offre, où le prêteur les retire : aucun transfert vers une adresse du prêteur sur le chemin de sortie de l'emprunteur (constat H2) |
| S4 | Plafond d'emprunt | `parts × prix × (10 000 − décote) / (10^décimales_oracle × 10 000)`, décimales du token de parts et du stablecoin prises en compte, arrondi vers le bas |
| S5 | Stablecoins acceptés | Registre tenu par l'admin, comme pour les fonds. **Liste blanche conforme à MiCA par construction** pour tout usage européen : EURC, EURCV, EURAU, USDC. USDT0 et PYUSD exclus : l'avis de l'ESMA du 8 octobre 2026 attend des autorités nationales qu'elles obtiennent des prestataires MiCA la fin des services sur les stablecoins non conformes dans un délai de trois mois, soit vers le 8 janvier 2027 ; il passe par les autorités nationales et ne s'impose pas directement (corrigé le 15 octobre 2026) |
| S6 | Pause d'urgence | `pause` et `unpause` réservées à l'admin. La pause bloque `create_offer` et `open_repo`, **jamais** `repurchase`, `withdraw_offer` ni `seize` : on arrête les entrées, pas les sorties. Un seul signataire suffit pour mettre en pause ; le pouvoir est étroitement délimité |
| S7 | Gouvernance de l'admin | Admin porté par un compte multisignature natif Stellar à seuils, avec au moins un signataire extérieur au mainteneur (**en place sur testnet**, 2 sur 2, le 15 octobre 2026 ; une clé seule est refusée par le réseau). **Version 3 : délai intégré au contrat**, plutôt qu'un TimelockController externe. Mise à niveau, remplacement d'un fonds, flux de secours, recalage de référence, nouveau gardien, hausse de la durée maximale, assouplissement de l'enveloppe, des limites d'un fonds ou d'un plafond par devise : proposition, délai (48 heures par défaut, réglable avant la première admission puis seulement à la hausse), application par n'importe qui dans les sept jours suivants, annulation par le gardien (et l'intendant pour ce qui touche son fonds). Tout resserrement est immédiat et efface l'assouplissement en attente ; un changement de gouverneur efface ses propositions. Le gardien peut céder son rôle à tout moment ; le gouverneur ne peut le remplacer seul qu'après 30 jours. La pause et `remove_fund` restent immédiates. Transfert d'admin en deux temps, **en place** : `set_admin` propose, `accept_admin` exige la signature du successeur. Rôles **en place** : gouverneur, gardien (pause des entrées seulement), un intendant par fonds (l'émetteur), qui approuve les prêteurs et règle son fonds dans l'enveloppe de risque ; l'admission d'un fonds exige le gouverneur et l'intendant, et un remplacement exige aussi l'intendant en place |
| S8 | Parts saisies | **Les prêteurs sont obligatoirement des détenteurs autorisés par l'émetteur** : l'intendant les approuve fonds par fonds, l'approbation est revérifiée à chaque ouverture, et la saisie va au prêteur ou à une autre adresse approuvée. Aucune présentation au rachat par le contrat n'est nécessaire |
| S9 | Gel ou reprise par l'émetteur pendant une pension | La dette reste due. **Version 3** : si le jeton de parts refuse le transfert au rachat ou à la saisie (gel du contrat, retrait de la liste blanche, reprise), la dette se solde quand même (remboursement dans l'offre, encours libérés, intérêt arrêté) et les parts dues sont inscrites au nom du bénéficiaire (`PendingRelease`). N'importe qui peut relancer la livraison (`release`) dès que l'émetteur l'autorise ; le bénéficiaire peut la rediriger. Les parts ne peuvent aller qu'au bénéficiaire inscrit, une fois. Rejoué sur testnet le 15 octobre 2026 |
| S10 | Bornes de ressources | Au plus 8 fonds par offre ; un seul transfert de parts et un seul transfert de stablecoins par opération ; aucune boucle sur l'ensemble des offres ou des pensions (I6) |
| S11 | Durée minimale | 1 heure |
| S12 | Identifiants | Compteurs monotones `NextOfferId` et `NextRepoId` en `u64`, jamais réutilisés |
| S13 | Événements | Un événement par transition d'état, identifiants et adresses en topics, pour l'audit, l'indexation et la réconciliation côté émetteur |
| S14 | Migration de schéma | Version de schéma stockée ; fonction `migrate` idempotente réservée à l'admin ; mécanisme de migration de données du SDK 28 |
| S15 | Fin d'upgradabilité | Le contrat reste upgradable derrière le délai d'attente et des rôles publiés. Engagement : renoncer à l'upgrade après le pilote si un émetteur le demande, par transfert de l'admin au timelock puis renonciation. Procédure écrite avant tout dépôt réel |
| S16 | Tampon de première perte | Réserve d'environ 5 % des offres déposées, conforme au repère des standards DeFi de la SDF, constituée avant tout dépôt réel sur le réseau principal |
| S17 | Plan de monitoring | Écrit avant tout dépôt réel, dérivé du modèle de menace : déclencheurs sur les événements du contrat, sur la déviation des prix et sur les soldes ; alerte en minutes ; pause automatique possible sur alerte. Exigé par la tranche 2 du fonds communautaire |
| S18 | Plafonds de lancement | Par pension, par fonds et au total, dérivés des scénarios de perte maximale (6.1). Le plafond total est aligné sur le seuil du premier audit de suivi gratuit de l'Audit Bank, 10 M$ de valeur bloquée |
| S19 | Offre sponsor | Une offre peut être marquée « sponsor » par l'intendant d'un fonds qu'elle accepte ; la marque est indicative, l'interface la présente en premier, sans appariement on-chain (invariant I6). Elle suit les mêmes règles que toute offre. Aucun privilège de sortie |

| S20 | Loyer du code du contrat | Les opérations prolongent l'instance du contrat, jamais l'entrée de code : le loyer croît avec la taille, et prolonger un code de 75 Ko à 120 jours coûtait environ 530 XLM sur testnet le 14 octobre 2026, au-delà des frais maximaux d'une transaction. L'utilisateur qui franchissait le seuil aurait payé ce loyer. L'opérateur prolonge désormais le code par tranches de 30 jours au plus (détecteur TTL du monitoring) ; test `operations_extend_the_instance_but_not_the_code` |
| S21 | Recalage de la référence de prix | La référence de valeur liquidative et de change ne quitte la trajectoire du modèle que par deux voies signées à deux clés : l'admission d'un fonds et le recalage (`propose_reanchor`), qui installe les valeurs que les deux signataires ont nommées (`expected_nav`, `expected_fx`), vérifiées contre les flux à la proposition, liées à ces flux, et appliquées après le délai seulement si la valeur liquidative suit encore le modèle depuis la proposition. Un remplacement de fonds ou une réadmission conservent la référence ; un nouveau flux doit lire dans le corridor en place. Personne ne choisit le moment d'un recalage au prix du jour |

### 6.1 Perte maximale par scénario

| Scénario | Ce qui limite la perte | Perte maximale |
|---|---|---|
| Prix manipulé ou oracle compromis | Corridor fondé sur un modèle (S2), bande de change et décotes : une manipulation dans le corridor ne crée pas de sous-collatéralisation ; hors corridor, refus | Zéro dans le corridor ; plafond par fonds si l'oracle entier est compromis |
| Clé admin compromise | Multisig natif ; délai de 48 h sur tout assouplissement et toute mise à niveau, avec veto du gardien que le gouverneur seul ne peut lever avant 30 jours (S7) ; sorties jamais bloquées (S6) ; annulation rejouée sur testnet 6 s après la proposition | Zéro si le gardien veille ; sinon les flux entrés après l'application |
| Gel ou reprise des parts par l'émetteur | Dette soldée, parts inscrites et livrées à la levée du gel (S9, version 3) ; sorties jamais bloquées | Retard de livraison ; en cas de reprise définitive, les parts reprises, au plus le plafond par fonds |
| Bug du contrat | Pause des entrées ; sorties intactes ; tampon (S16) | Valeur bloquée au moment du bug, donc plafond total |
| Prêteur non autorisé à recevoir les parts | Impossible par construction (S8) | Zéro |

### 6.2 Réponses aux attentes externes

- **Standards DeFi de la SDF (20 juillet 2026)** : audit publié avec version du code ; politique de divulgation (`SECURITY.md`) et bug bounty à dimensionner sur la valeur exposée ; procédures de risque écrites ; stress tests ; tampon de première perte (S16) ; aucun flux de prix unique pour une décision qui touche au collatéral (S1, S2) ; multisig et délai d'attente (S7) ; pouvoirs d'urgence étroits (S6) ; détection en minutes (S17) ; rapport préliminaire sous 48 heures ; page publique des risques.
- **ESMA, appel à contributions du 9 octobre 2026, section 6** : les risques qu'elle nomme, gestion des clés, permissions, exécution des contrats, privilèges administratifs, perte ou compromission de clés privées, dysfonctionnement de contrat, intervention de gouvernance, conversion sous stress du collatéral, correspondent aux scénarios de 6.1 et aux décisions S6, S7, S9 et S15.
- **FMI, rapport de stabilité financière d'octobre 2026, chapitre 3** : l'avertissement selon lequel le collatéral programmable et le règlement instantané peuvent accélérer les liquidations forcées ne s'applique pas à cette conception : durée fixe, pas d'appel de marge, pas de liquidation automatique ; le contrat refuse une opération plutôt que de liquider une position.
- **DORA** : voir 6.3.

### 6.3 DORA : position et exigences retenues (13 octobre 2026)

**Champ.** DORA, règlement (UE) 2022/2554, s'applique aux entités financières de l'article 2, paragraphe 1, points a) à t) : notamment sociétés de gestion, gestionnaires de FIA, entreprises d'investissement, établissements de monnaie électronique, prestataires MiCA et émetteurs d'ART. Le projet n'en fait pas partie. Il n'est pas non plus un prestataire critique désigné au titre de l'article 31, désignation fondée sur l'impact systémique, le nombre d'entités servies et la substituabilité.

**Ce qui nous concerne quand même.** Les émetteurs de parts et de stablecoins avec lesquels le contrat travaille sont des entités financières. Elles restent « à tout moment pleinement responsables » (article 28, paragraphe 1) et répercutent leurs obligations par contrat. Deux cas se distinguent, comme un firmware livré se distingue d'un service exploité :

| Cas | Qualification | Conséquence |
|---|---|---|
| L'émetteur déploie et exploite lui-même une instance du code open source | Livraison de logiciel, pas de service continu | Rien n'entre dans son registre au titre du projet ; DORA reste entièrement chez l'émetteur |
| Le projet exploite l'instance : administration, registre des fonds, délai d'attente, monitoring, support | Service TIC « fourni de manière continue » (article 3, point 21) ; le projet devient prestataire tiers de services TIC (article 3, point 19) | Une ligne dans le registre d'informations de l'émetteur (article 28, paragraphe 3) ; contrat conforme à l'article 30 |

La qualification d'un service comme service TIC dépend de la définition de l'article 3, point 21 : la Q&A 2024_7290 (réponse de la Commission publiée par l'ABE le 14 novembre 2025) l'applique aux prestataires de paiement et exclut les services sans composante TIC prépondérante, mais ne dit pas qui tranche la qualification ; la question est posée au conseil (corrigé le 15 octobre 2026). Il en va de même pour la classification en fonction critique ou importante (article 3, point 22) : aucune liste officielle n'existe. Un pilote plafonné, dont la panne laisse intact le rachat quotidien au guichet du fonds, ne relève vraisemblablement que des clauses de l'article 30, paragraphe 2. Une sortie instantanée annoncée aux clients de l'émetteur serait vraisemblablement classée importante, ce qui ajoute les clauses de l'article 30, paragraphe 3.

**Décision D1 : concevoir pour l'article 30, paragraphe 3, dès maintenant.** Le surcoût est faible à ce stade et le rattrapage tardif serait coûteux. Chaque clause est rattachée à une réponse :

| Clause | Exigence | Réponse du projet | État |
|---|---|---|---|
| 30(2)(a) | Description complète des fonctions et services, sous-traitance | Spécification fonctionnelle ; sous-traitants nommés : fournisseur de prix, RPC, monitoring, hébergeur de l'indexeur | À écrire |
| 30(2)(b) | Lieux de fourniture et de traitement | La chaîne est publique et mondiale par nature ; monitoring, indexeur et hébergement déclarés et situés dans l'Union européenne | À décider |
| 30(2)(c), (d) | Intégrité, confidentialité, accès, récupération et restitution des données | Événements par transition (S13), état public, indexeur conservant l'historique ; export lisible | Partiel |
| 30(2)(e) | Niveaux de service | Sorties disponibles en permanence par conception (S6) ; délais de réponse humaine à chiffrer | Partiel |
| 30(2)(f) | Assistance en cas d'incident | Responsable d'incident nommé ; notification à l'émetteur sous 4 heures, alignée sur ses propres délais de déclaration d'incident majeur ; rapport sous 48 heures | À écrire |
| 30(2)(g), (h), (i) | Coopération avec les autorités, résiliation, formation | Engagement de coopération ; résiliation sans pénalité ; participation aux sessions de sensibilisation de l'émetteur | À écrire |
| 30(3)(a) | Objectifs de performance quantitatifs | Délai de règlement d'une transaction ; délai de détection d'anomalie (S17) ; disponibilité des sorties | À chiffrer |
| 30(3)(b) | Préavis et obligations d'information | Délai de 48 heures sur tout changement de code ou d'oracle (S7) ; file du timelock publique | En place par conception |
| 30(3)(c) | Plans de continuité testés | Pause des entrées (S6), procédure de fin de vie sous 7 jours, tampon de première perte (S16) ; répétition sur testnet | À tester |
| 30(3)(d) | Participation aux tests de pénétration fondés sur la menace (TLPT) | Engagement de participer aux TLPT de l'émetteur ; modèle STRIDE et plan de monitoring fournis | Nouveau |
| 30(3)(e) | Droit de suivi, d'accès, d'inspection et d'audit illimité | Code public, rapport d'audit publié, événements on-chain ; accès à l'exploitation (journaux, procédures) pour l'émetteur et son autorité | Partiel |
| 30(3)(f) | Stratégie de sortie et période de transition | L'émetteur peut reprendre l'instance open source en interne ou la confier à un autre opérateur ; échéance de toutes les pensions sous 7 jours au plus ; politique de fin d'upgradabilité (S15) | En place par conception |
| 28(5) | Normes de sécurité de l'information | Présente base de sécurité, audit externe ; attestation indépendante à l'échelle (standards SDF) | Partiel |

**Décision D2 : offrir les deux modes.** Instance exploitée par le projet, ou instance exploitée par l'émetteur à partir du code public. Le second mode est la stratégie de sortie de l'émetteur et réduit son risque de concentration (article 29).


## 7. Chaîne d'outils et processus de revue

### En place

| Mécanisme | Où | Rôle |
|---|---|---|
| Chaîne d'outils figée (Rust 1.98.1, cible `wasm32v1-none`, `rustfmt`, `clippy`) | `rust-toolchain.toml` | Même binaire pour tous et pour la CI ; les changements de version sont volontaires et tracés |
| Lints de sécurité en `deny` | `Cargo.toml`, `[workspace.lints]` | `unsafe_code`, `arithmetic_side_effects`, `unwrap_used`, `expect_used`, `panic`, `indexing_slicing`. Les tests les désactivent explicitement en tête de `test.rs` |
| `overflow-checks = true` en release et en test | `Cargo.toml` | Filet de sécurité si un calcul échappe aux lints |
| CI bloquante | `.github/workflows/ci.yml` | `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test`, `stellar contract build`, et `cargo audit` (avis RustSec sur `Cargo.lock`) dans un job séparé |
| Chaîne d'approvisionnement de la CI | `.github/workflows/ci.yml`, `.github/dependabot.yml` | Permissions au plus juste (`contents: read` par défaut, `issues: write` limité au job d'audit) ; chaque action tierce figée sur un SHA de commit complet ; Rust installé depuis `rust-toolchain.toml` sans action tierce ; Dependabot propose les mises à jour des actions et des crates en PR relues |
| Cibles Make | `contracts/night-window/Makefile` | `make lint`, `make audit`, `make scout` reproduisent les contrôles en local |

### Règles de revue à chaque modification du contrat

1. Pour chaque fonction publique, lister chaque argument `Address` et dire quelle autorité chaque écriture consomme. Chaque autorité consommée a son `require_auth` dans cette fonction.
2. Pour chaque appel externe (token, oracle), dire ce qui se passe s'il échoue, s'il renvoie une valeur absurde, ou s'il consomme tout le budget.
3. Pour chaque calcul, montrer qu'il est en `checked_*` et dans quel sens il arrondit.
4. Pour chaque nouvelle entrée de stockage, dire qui prolonge son TTL et ce qui se passe si elle est archivée.
5. Chaque chemin d'erreur a un test `try_` ; chaque fonction privilégiée a un test qui prouve le refus d'un intrus ; chaque événement est comparé en XDR.
6. Aucune renumérotation d'erreur, aucune modification d'un type exporté existant : on ajoute des variantes.

### Avant le testnet public

- Modèle de menace STRIDE tenu à jour dans [modele-menace-stride.md](modele-menace-stride.md) : au moins un problème identifié par catégorie, un traitement par problème, revue à chaque changement d'architecture. Il est exigé par la tranche 2 du fonds communautaire et par l'évaluation de préparation de l'Audit Bank.
- Analyse statique : `cargo scout-audit` (CoinFabrik) et les détecteurs OpenZeppelin pour Soroban ; corriger ou justifier chaque alerte dans ce document.
  - **Scout : fait** (14 octobre 2026, `cargo-scout-audit` 0.3.17, détecteurs compilés sur `nightly-2025-09-18`, toolchain installée pour l'outil seul) : 0 critique, 2 moyennes, 0 mineure, 23 améliorations. Aucune ne demande de correction du contrat.
    - `missing-new-admin-auth` (moyenne), `set_admin` : justifié : `set_admin` n'enregistre qu'un gouverneur proposé (`PendingAdmin`) ; le rôle ne change que dans `accept_admin`, après `require_auth` de l'adresse proposée (S7, test `governor_handover_takes_two_steps`).
    - `avoid-vec-map-input` (moyenne), paramètre `funds` de `create_offer` : justifié : chaque élément est converti et contrôlé avant l'écriture (1 à 8 fonds, sans doublon, fonds admis, même devise, prêteur approuvé) ; un élément mal typé fait échouer la seule transaction de l'appelant et rien n'est stocké (test `offer_checks`).
    - `storage-change-events` (amélioration), 23 fonctions qui écrivent en stockage : justifié : chacune publie un événement `#[contractevent]` par `.publish(&env)` (`events.rs`) ; le détecteur ne reconnaît que l'appel direct `env.events()`. `refresh_reference` n'écrit que lorsqu'elle publie `ReferenceUpdated`.
  - Détecteurs OpenZeppelin : pas encore passés.
  - Revue ponctuelle `cargo clippy --all-targets -- -W clippy::pedantic -W clippy::nursery`, non imposée : aucun défaut réel. Dans le contrat, passage par valeur imposé par l'ABI des points d'entrée, sections `# Errors`, `#[must_use]`, `const fn`, `Self`, import global ; `suspicious_operation_groupings` sur `check_fund_config` est un faux positif (la borne `max_corridor_floor_bps` est la bonne). Les conversions signalées sont dans les tests, sur des valeurs bornées.
- Tests de propriété sur I1, I2, I5 et sur les arrondis de S3 et S4 ; test de montée en charge qui ouvre un grand nombre de pensions et vérifie un coût constant par opération (exigence du cadrage).
  - **Montée en charge : fait.** `many_repos_keep_a_constant_footprint_per_operation` ouvre 200 pensions (4 offres, 2 prêteurs, 5 emprunteurs) puis les rachète toutes. De la deuxième ouverture à la dernière, `open_repo` lit 17 entrées et en écrit 9 (la première crée le solde de parts du contrat) ; du premier rachat au dernier, `repurchase` lit 13 entrées et en écrit 9. I1, I2 et les encours sont vérifiés au pic et à la fin. Environ 25 s.
- Test de mise à niveau : chemin nominal avec un WASM réellement téléversé, et refus d'un non-admin.
  - **Fait.** `upgrade_to_the_built_wasm_keeps_offers_repos_and_roles` téléverse le `night_window.wasm` produit par `stellar contract build` et y bascule un contrat qui porte deux offres, deux pensions ouvertes, une pension rachetée, un gardien distinct, un plafond de durée modifié et la pause. Après `upgrade` signé du gouverneur, l'entrée d'instance pointe sur le hash téléversé ; offres, pensions, fonds, rôles, plafonds, approbation du prêteur, soldes et pause sont identiques ; `version` répond ; sous le WASM, une pension ouverte est rachetée pendant la pause, puis une nouvelle est ouverte et rachetée ; un intrus ne peut pas remettre à niveau (aussi `intruder_cannot_upgrade`). La CI et `make test` construisent le WASM avant clippy et les tests ; sans lui, le test ne compile pas et le message demande `stellar contract build`.
- Admin multisignature (S7), pause disponible (S6), procédure d'incident écrite (qui appelle `pause`, comment, et comment on communique aux prêteurs et emprunteurs) avec un responsable d'incident nommé.
  - **Pause : faite** (gardien, entrées seulement). **Procédure d'incident : faite**, [procedure-incident.md](procedure-incident.md), avec la répétition du plan de monitoring du 14 octobre 2026. Le titulaire du rôle de responsable d'incident est désigné hors du dépôt. **Multisig : pas encore.**
- Relecture lors des Security Office Hours de Runtime Verification, sessions individuelles gratuites proposées par l'écosystème.

### Avant le mainnet

- **Garde des clés, chemin critique** (15 octobre 2026). Aucun rôle ne doit tenir sur une seule machine comme dans la démonstration. Cible : gouverneur multisig natif à 2 signatures sur 3, sur portefeuilles matériels qui signent désormais les appels Soroban, dont un signataire extérieur à l'équipe, clé maîtresse désactivée ; gardien réduit à un compte intelligent qui ne peut que suspendre et annuler, la cession de son rôle restant aux signataires humains ; intendant de chaque fonds en multisig chez l'émetteur, distinct de son compte d'administration du jeton ; payeur de loyer du code sur un compte plafonné, sans rôle dans le contrat ; aucune personne ne tient deux rôles. Trois durcissements du contrat en découlent, à décider : délai sur la passation du gouverneur, cession du rôle de gardien limitée à une adresse de secours enregistrée, voie de remplacement d'un intendant dont la clé est perdue. En attendant, la passation du gouverneur et le remplacement forcé du gardien lèvent une alerte critique.
- Audit externe par un cabinet pré-approuvé de l'Audit Bank (Certora, Code4rena, ChainSecurity, Halborn, Oak Security, OtterSec, Runtime Verification, Spearbit et Cantina, Veridise, Zellic). Le programme couvre jusqu'à 100 % du premier audit des projets financés par le fonds communautaire, contre une participation de 5 % remboursée si tous les constats critiques, élevés et moyens sont corrigés sous 20 jours ouvrés ; audits de suivi gratuits à 10 M$ et 100 M$ de valeur bloquée. Conditions d'entrée : code complet et proche du mainnet, testnet déployé, modèle STRIDE, résultats d'analyse statique avec plan de correction. Le rapport final est publié par le cabinet. Le code en production doit être celui qui a été audité ; tout changement significatif déclenche une revue ciblée.
- Surveillance des événements, des prix et des TTL en production (Hypernative ou OctoPos, guide SDF de juillet 2026), reliée au plan de monitoring (S17), avec pause sur alerte.
- Politique de divulgation responsable publiée (`SECURITY.md`) et bug bounty dimensionné sur la valeur exposée.
- Tampon de première perte constitué (S16), plafonds de lancement en place (S18), page publique des risques (audits, rôles privilégiés, dépendances, historique d'incidents).
- Règle de maintenance : rester dans les deux dernières versions majeures de `soroban-sdk`, les seules qui reçoivent les correctifs de sécurité ; rebuild et tests à chaque mise à niveau du protocole ; échéances en secondes, jamais déduites des TTL.

## 8. Questions du cadrage et réponses apportées

1. **Qui porte la clé d'administration ?** Une clé unique pendant le hackathon ; un multisig natif à seuils avec un signataire extérieur dès le testnet public ; un TimelockController devant l'upgrade et l'oracle avant tout dépôt réel (S7, S15).
2. **L'émetteur accepte-t-il que le contrat détienne des parts ?** Techniquement, le contrat est une adresse comme une autre pour la liste blanche d'un émetteur : sur Stellar, le token d'un émetteur régulé exige le même rôle sur l'expéditeur et le destinataire, et le propre contrat de rachat de cet émetteur doit le détenir. Pour un actif classique à autorisation requise, l'émetteur autorise l'adresse du contrat via `set_authorized`. La décision commerciale reste celle de l'émetteur ; S8 et S9 fixent les règles de gel et de saisie.
3. **L'oracle publie-t-il le week-end ?** Les flux de valeur liquidative pour les parts de fonds existent sur Stellar (RedStone, 18 flux SEP-40 dont BENJI ; Pyth) ; leur rythme de publication est un paramètre par fonds (S1), complété par le corridor (S2) et la décote.
4. **Faut-il un plafond global ?** Oui (S18) : par pension, par fonds et au total, aligné sur le premier seuil d'audit de suivi.
5. **Qui décide de la pause ?** Un seul signataire, pouvoir limité aux entrées (S6) ; les prêteurs gardent le retrait de la part non prêtée à tout moment.

Questions restant ouvertes : le prix d'un flux de valeur liquidative pour un fonds qui n'en a pas encore ; la classification du service en fonction critique ou importante par chaque émetteur (la conception vise le cas le plus exigeant, décision D1 de la section 6.3) ; la localisation dans l'Union européenne du monitoring et de l'indexeur ; le coût réel du monitoring.

## 9. Sources

- Skill officiel `stellar-dev`, fichiers `security.md`, `development.md` et `testing.md` (v1.2.0), appliqués au cas présent.
- Documentation : [stratégies de stockage](https://developers.stellar.org/docs/build/guides/storage/storage-strategies), [mise à niveau des contrats](https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts), [autorisation des soldes SAC](https://developers.stellar.org/docs/tokens/stellar-asset-contract#balance-authorization-required), [frais et limites](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering).
- Standards : [SEP-40](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md) (oracle), [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) (token), [SEP-49](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0049.md) (contrats évolutifs).
- Audits publics de protocoles de prêt sur Stellar, pour les défauts de liquidation qui parcourent toutes les positions : [Slender, Certora](https://stellarsecurityportal.com/report/24), [Peridot, Halborn](https://stellarsecurityportal.com/report/83).
- Outils : [Scout pour Soroban](https://github.com/CoinFabrik/scout-soroban), [Security Detectors SDK](https://github.com/OpenZeppelin/soroban-security-detectors-sdk), [RustSec](https://rustsec.org), [Audit Bank](https://stellar.org/grants-and-funding/soroban-audit-bank), [règles officielles de l'Audit Bank](https://stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank/official-rules), [TimelockController pour Soroban](https://docs.openzeppelin.com/stellar-contracts/governance/timelock-controller), [multisig natif](https://developers.stellar.org/docs/learn/fundamentals/transactions/signatures-multisig#thresholds).
- Standards et attentes externes : [Stellar DeFi Security Standards and Best Practices, SDF, 20 juillet 2026](https://stellar.org/blog/ecosystem/stellar-defi-security-standards-and-best-practices) ; [critères de soumission du fonds communautaire, tranche 2](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/submission-criteria) ; [guide de modèle de menace STRIDE, Stellar](https://developers.stellar.org/docs/build/security-docs/threat-modeling/threat-modeling-how-to) ; [Auditing Smart Contracts on Stellar, Certora, 7 octobre 2026](https://www.certora.com/blog/auditing-smart-contracts-stellar) ; [Monitoring Stellar with Hypernative, SDF](https://stellar.org/blog/developers/monitoring-stellar-with-hypernative) ; [ESMA, Call for evidence on CCP collateral tokenisation, 9 octobre 2026](https://www.esma.europa.eu/sites/default/files/2026-10/ESMA91-1505572268-4934_-_Call_for_evidence_tokenisation.pdf) ; [ESMA, avis du 8 octobre 2026 sur les stablecoins non conformes à MiCA, via CoinDesk](https://www.coindesk.com/policy/2026/10/08/eu-securities-regulator-gives-crypto-platforms-3-months-to-remove-unauthorized-stablecoins) ; [FMI, GFSR octobre 2026, chapitre 3](https://www.imf.org/-/media/files/publications/gfsr/2026/october/english/ch3.pdf).
- DORA : [règlement (UE) 2022/2554, EUR-Lex](https://eur-lex.europa.eu/eli/reg/2022/2554/oj/eng) ; [article 2](https://www.springlex.eu/en/packages/dora/dora-regulation/article-2/), [article 3](https://www.springlex.eu/en/packages/dora/dora-regulation/article-3/), [article 28](https://www.springlex.eu/en/packages/dora/dora-regulation/article-28/), [article 30](https://www.springlex.eu/en/packages/dora/dora-regulation/article-30/), [article 31](https://www.springlex.eu/en/packages/dora/dora-regulation/article-31/) ; [Q&A 2024_7290 sur la notion de service TIC, ABE, 14 novembre 2025](https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2024_7290).
- Incidents de référence : [YieldBlox, 22 février 2026, post-mortem Blockaid](https://www.blockaid.io/blog/73-quarantined-how-blockaid-and-stellar-validators-contained-a-10m-price-manipulation-attack) ; [Comet, 25 août 2026, post-mortem](https://lumenloop.com/news/comet-blnd-usdc-lp-incident-post-mortem).
- Conventions Rust (gestion d'erreurs par `Result`, pas d'`unwrap` en production, rustfmt et Clippy) : *Mastering Rust Programming*, A. M. Veldt, 2025, conservé hors du dépôt dans `references/`.
