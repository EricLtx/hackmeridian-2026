# Modèle de menace STRIDE du contrat Open Window (crate `night-window`)

Date : 13 octobre 2026 · Statut : **initié, à compléter avec l'implémentation du cycle de vie** · Méthode : guide de modèle de menace de Stellar (quatre questions, six catégories STRIDE, au moins un problème par catégorie, un traitement par problème) · Document frère : [securite.md](securite.md), qui porte les invariants, les classes de vulnérabilité et les décisions S1 à S19.

Ce document répond aux exigences de la tranche 2 du fonds communautaire Stellar (modèle de menace et plan de monitoring) et de l'évaluation de préparation de l'Audit Bank. Il est un outil vivant : il est refait à chaque changement d'architecture et relu avant chaque audit.

---

## 1. Sur quoi travaillons-nous ?

### 1.1 Cas d'usage

Un détenteur de parts de fonds monétaire tokenisé (emprunteur) bloque ses parts dans le contrat et reçoit des stablecoins dans la même transaction, pour une durée et un taux fixés d'avance. Il rembourse principal et intérêt et récupère ses parts. Les stablecoins viennent d'offres déposées à l'avance par des prêteurs, dont l'émetteur du fonds lui-même peut faire partie. En cas de défaut après l'échéance, le prêteur saisit les parts.

### 1.2 Entités externes

| Entité | Confiance | Rôle |
|---|---|---|
| Emprunteur | Aucune | Appelle `open_repo` et `repurchase` |
| Prêteur, dont l'émetteur en tant que prêteur sponsor | Aucune | Appelle `create_offer`, `withdraw_offer`, `seize` |
| Administrateur (multisig, puis timelock) | Élevée, encadrée | Registre des fonds et des stablecoins, pause, upgrade |
| Émetteur du fonds | Externe, subie | Tient la liste blanche de ses parts ; peut geler ou reprendre un solde |
| Oracle SEP-40 (RedStone, Pyth) | Allowlisté | Publie la valeur liquidative de la part |
| Tokens SEP-41 et SAC (parts, stablecoins) | Allowlistés | Transfèrent les soldes |
| Hôte Soroban, validateurs | Totale | Autorisation, anti-réentrance, mesure des ressources, archivage |
| Opérateur de monitoring (Hypernative ou équivalent) | Moyenne | Observe les événements, peut déclencher la pause via un signataire |
| Indexeur, RPC | Faible | Lecture seule ; aucune décision du contrat n'en dépend |

### 1.3 Processus

Les fonctions du contrat : `__constructor`, `set_admin`, `upgrade`, `set_max_term`, `set_fund`, `remove_fund`, `fund_price`, `create_offer`, `withdraw_offer`, `open_repo`, `repurchase`, `seize`, `get_offer`, `get_repo` ; à venir : `pause`, `unpause`, `set_stablecoin`, `remove_stablecoin`, `migrate`, et un contrat TimelockController devant les fonctions privilégiées non urgentes.

### 1.4 Flux de données

1. Prêteur → contrat : stablecoins (transfert SEP-41) et paramètres de l'offre.
2. Emprunteur → contrat : parts (transfert SEP-41 ou SAC) ; contrat → oracle : lecture `lastprice` ; contrat → emprunteur : stablecoins.
3. Emprunteur → contrat : principal et intérêt ; contrat → emprunteur : parts ; contrat → prêteur : principal et intérêt.
4. Prêteur → contrat : `seize` ; contrat → prêteur : parts.
5. Admin → contrat : registre, pause, upgrade, via timelock pour les changements non urgents.
6. Contrat → monde : événements de cycle de vie, lus par l'indexeur et le monitoring.

### 1.5 Stockage

| Entrée | Type | Contenu sensible |
|---|---|---|
| `Admin`, `MaxTerm`, `Paused`, `SchemaVersion` | Instance | Autorité et paramètres globaux |
| `Fund(adresse)` | Persistant | Oracle, actif oracle, décote, fraîcheur, bande |
| `Stablecoin(adresse)` | Persistant | Liste blanche MiCA |
| `Offer(id)` | Persistant | Prêteur, stablecoin, montant disponible, taux, durée max, fonds acceptés, sponsor |
| `Repo(id)` | Persistant | Emprunteur, prêteur, fonds, parts, principal, taux, échéance (timestamp), état |
| `NextOfferId`, `NextRepoId` | Instance | Compteurs monotones |

### 1.6 Frontières de confiance

- **F1, utilisateur ↔ contrat** : tout argument est hostile ; chaque autorité consommée est ré-authentifiée dans la fonction.
- **F2, contrat ↔ tokens** : un token peut échouer, renvoyer un montant différent (token à permissions, gel), ou être faux ; d'où la liste blanche et la vérification des soldes avant et après transfert.
- **F3, contrat ↔ oracle** : la donnée est externe ; fraîcheur, corridor fondé sur un modèle, bande de change, refus en cas de doute.
- **F4, admin ↔ contrat** : l'autorité la plus forte ; multisig, timelock, pouvoirs d'urgence étroits.
- **F5, émetteur ↔ parts** : l'émetteur peut geler ou reprendre ; la règle S9 fixe les conséquences.
- **F6, chaîne ↔ hors chaîne** : monitoring, indexeur, interface web ; aucune décision du contrat n'en dépend, mais la réponse à incident en dépend.

## 2. Qu'est-ce qui peut mal tourner ?

Chaque problème est numéroté par catégorie. Les invariants I1 à I9 et les décisions S1 à S19 sont ceux de [securite.md](securite.md).

### Usurpation (Spoofing)

| # | Problème | Traitement |
|---|---|---|
| Spoof.1 | Un tiers retire une offre, saisit une pension ou rembourse au nom d'un autre | `require_auth` sur `lender` dans `create_offer` et `withdraw_offer`, sur `borrower` dans `open_repo` et `repurchase` ; prêteur chargé depuis `Repo` dans `seize`. Test : `mock_auths` ciblé, refus d'un intrus, arbre `env.auths()` vérifié |
| Spoof.2 | Un faux oracle ou un faux token imite l'interface SEP-40 ou SEP-41 | Adresses lues uniquement depuis le registre, jamais depuis un argument (S5, registre des fonds) |
| Spoof.3 | Rejeu d'une autorisation pré-signée via un contrat intermédiaire | Chaque couche qui exerce l'autorité d'une adresse la ré-authentifie ; nonces et expirations gérés par l'hôte |

### Altération (Tampering)

| # | Problème | Traitement |
|---|---|---|
| Tamper.1 | Prix manipulé pour emprunter plus que la valeur des parts (incident YieldBlox, février 2026) | Flux de valeur liquidative, jamais un prix de DEX ; corridor fondé sur un modèle avec une référence qui ne suit pas le flux (S2) ; fraîcheur (S1) ; bande et décote de change ; décote ; refus hors corridor. Tests : `reference_cannot_be_ratcheted_by_a_faulty_feed`, `corridor_refuses_a_jump_faster_than_the_maximum_yield` |
| Tamper.2 | Débordement ou arrondi défavorable dans le calcul d'intérêt ou du plafond d'emprunt | `checked_*` imposé par les lints, `overflow-checks` en release et test, arrondis fixés (S3, S4), tests de propriété |
| Tamper.3 | Modification des conditions d'une pension ouverte par un changement de registre | I9 : conditions figées à l'ouverture ; `remove_fund` n'affecte pas les pensions ouvertes |
| Tamper.4 | Upgrade malveillant ou erroné qui corrompt le stockage | Timelock 48 h (S7), clés de stockage jamais renommées ni retypées, version de schéma et `migrate` (S14), test d'upgrade avec WASM réel |

### Répudiation (Repudiation)

| # | Problème | Traitement |
|---|---|---|
| Repud.1 | Un prêteur ou un émetteur conteste une saisie ou un montant | Un événement par transition avec identifiants et adresses en topics (S13), comparés en XDR dans les tests ; indexeur conservant l'historique au-delà des 7 jours du RPC |
| Repud.2 | L'administrateur change un paramètre sans trace | Événement sur chaque changement administratif, file du timelock publique |

### Divulgation (Information Disclosure)

| # | Problème | Traitement |
|---|---|---|
| Disc.1 | Positions et contreparties lisibles par tous sur une chaîne publique | Accepté et documenté : les parts sont déjà à permissions, les parties sont déjà connues de l'émetteur. Confidentialité des montants hors périmètre de la version 1 ; piste : token confidentiel OpenZeppelin pour Soroban |
| Disc.2 | Clés d'administration ou de déploiement exposées dans le dépôt ou la CI | Aucun secret dans le dépôt (vérifié), identités Stellar locales ignorées par git, actions CI figées sur SHA, permissions au plus juste |

### Déni de service (Denial of Service)

| # | Problème | Traitement |
|---|---|---|
| DoS.1 | Une opération dépasse les limites de ressources parce qu'elle parcourt toutes les positions | I6 : une entrée par offre et par pension, aucune boucle globale ; au plus 8 fonds par offre (S10) ; test de montée en charge à coût constant |
| DoS.2 | Entrée archivée (TTL expiré) qui bloque un rachat ou une saisie | Échéances en timestamp, jamais en TTL ; TTL prolongé à chaque écriture ; tâche de prolongation en RUN ; restauration possible par l'appelant |
| DoS.3 | Oracle muet ou périmé un week-end | Refus explicite (`NoPrice`, `StalePrice`) plutôt que prix par défaut ; paramètre de fraîcheur par fonds ; second oracle en version suivante |
| DoS.4 | Pause abusive qui bloque les sorties | La pause ne touche que `create_offer` et `open_repo` (S6) ; `repurchase`, `withdraw_offer` et `seize` restent toujours disponibles |
| DoS.5 | Gel ou reprise des parts par l'émetteur pendant une pension | Règle S9 : dette maintenue. Aujourd'hui, le rachat échoue tant que l'émetteur gèle les parts du contrat ; limite documentée et couverte par un test ; clôture sans restitution prévue en version 1.1 |
| DoS.6 | Pensions de quelques secondes qui sondent ou saturent le contrat | Durée minimale d'une heure (S11), plafonds (S18) |

### Élévation de privilège (Elevation of Privilege)

| # | Problème | Traitement |
|---|---|---|
| Elev.1 | Capture de l'admin par une fonction d'initialisation rejouable | Écartée : constructeur `__constructor`, pas d'`initialize` |
| Elev.2 | Compromission de la clé admin | Multisig natif à seuils avec signataire extérieur ; timelock 48 h sur upgrade et oracle ; transfert d'admin en deux temps (S7) ; pouvoirs d'urgence limités aux entrées |
| Elev.3 | Un prêteur sponsor obtient un privilège de sortie ou de saisie | S19 : la marque sponsor est indicative, posée par l'intendant, sans appariement on-chain ; mêmes règles que toute offre |
| Elev.4 | Un prêteur non autorisé par l'émetteur reçoit des parts saisies et les bloque | S8 : seuls des prêteurs approuvés par l'intendant peuvent prêter ; vérifié à `create_offer`, de nouveau à chaque `open_repo`, et sur l'adresse de destination de `seize` |

## 3. Que faisons-nous ?

Les traitements ci-dessus se répartissent en trois états :

État au 14 octobre 2026, cycle de vie implémenté :

- **En place et testé** : Spoof.1, Spoof.2, Spoof.3, Tamper.1, Tamper.2, Tamper.3, Repud.2, Disc.2, DoS.1, DoS.2, DoS.3, DoS.4, DoS.6, Elev.1, Elev.3, Elev.4. Les plafonds par pension, par fonds et par devise sont en place.
- **En partie** : Repud.1 (événements en place, indexeur à construire), Tamper.4 (mise à niveau réservée au gouverneur ; délai d'attente et test avec un WASM réel à faire), DoS.5 (limite documentée, traitement en version 1.1).
- **À mettre en place avant tout dépôt réel** : Elev.2 (multisig, délai d'attente), le plan de monitoring ci-dessous rejoué sur testnet, le tampon de première perte.

Le calendrier de ces étapes est dans [roadmap.md](roadmap.md).

### 3.1 Plan de monitoring, première version

Le plan découle du modèle : chaque menace qui ne peut pas être rendue impossible par le code reçoit un détecteur et une action.

| Menace | Détecteur | Seuil | Action |
|---|---|---|---|
| Tamper.1 | Prix lu par `fund_price` comparé au corridor de la référence | Sortie du corridor, ou prix inchangé depuis plus de N heures | Alerte immédiate ; pause des entrées par le gardien |
| Elev.2 | Opérations programmées dans le timelock ; appels à `set_admin`, `upgrade`, `set_fund` | Toute occurrence | Alerte immédiate ; vérification par un second signataire pendant le délai |
| DoS.2 | TTL restant des entrées `Fund`, `Offer`, `Repo` ouvertes | Moins de 14 jours | Prolongation automatique ; alerte si l'échec se répète |
| DoS.1, DoS.6 | Nombre de pensions ouvertes par heure, montant par pension, total bloqué | Dépassement des plafonds S18, ou rythme anormal | Alerte ; pause des entrées |
| DoS.5 | Solde du contrat en parts par fonds comparé à la somme des pensions ouvertes (I2) | Écart non nul | Alerte immédiate : gel ou reprise probable par l'émetteur |
| Repud.1 | Absence d'événement attendu après une transaction réussie | Toute occurrence | Alerte ; investigation |

Outils envisagés : Hypernative (guide SDF de juillet 2026, deux exemples publiés) ou OctoPos ; alertes vers le responsable d'incident ; rapport préliminaire sous 48 heures en cas d'incident, post-mortem public.

## 4. Avons-nous bien travaillé ?

Liste de revue, à reprendre à chaque changement d'architecture :

- [ ] Le diagramme de flux (1.4) a été relu après l'implémentation du cycle de vie.
- [ ] Chaque catégorie STRIDE a au moins un problème identifié : oui, six catégories, 21 problèmes.
- [ ] Chaque problème a un traitement et, quand il est implémentable, un test nommé.
- [ ] Les problèmes découverts après coup sont ajoutés ici, pas seulement corrigés.
- [ ] Le plan de monitoring a été rejoué sur testnet avec au moins un déclencheur réel.
- [ ] Le modèle a été relu lors d'une session Security Office Hours ou par l'auditeur.

## 5. Sources

- [Threat Modeling How-To Guide, Stellar](https://developers.stellar.org/docs/build/security-docs/threat-modeling/threat-modeling-how-to)
- [Stellar DeFi Security Standards and Best Practices, SDF, 20 juillet 2026](https://stellar.org/blog/ecosystem/stellar-defi-security-standards-and-best-practices)
- [Critères de soumission du fonds communautaire, tranche 2](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/submission-criteria)
- [Monitoring Stellar with Hypernative, SDF](https://stellar.org/blog/developers/monitoring-stellar-with-hypernative)
- [Auditing Smart Contracts on Stellar, Certora, 7 octobre 2026](https://www.certora.com/blog/auditing-smart-contracts-stellar)
- [Post-mortem YieldBlox, Blockaid](https://www.blockaid.io/blog/73-quarantined-how-blockaid-and-stellar-validators-contained-a-10m-price-manipulation-attack)
- [Stratégies de stockage et TTL](https://developers.stellar.org/docs/build/guides/storage/storage-strategies#strategy-5-ttl-management--bump-on-access)
