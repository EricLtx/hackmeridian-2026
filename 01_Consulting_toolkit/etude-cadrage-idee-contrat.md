# Étude de cadrage — contrat de mise en pension de fonds monétaires tokenisés

Date : 5 octobre 2026 · Statut : **cadrage terminé, en attente de validation avant spécification** · Événement visé : HackMeridian 2026 (Lisbonne, 25–26 octobre)

> **Version consolidée :** `proposition-commerciale-guichet-de-nuit.pdf` (sources dans `proposition-commerciale/`). Elle reprend cette étude avec des chiffres vérifiés à la source, un scénario de taux à 11 % et le taux de Blend comme repère. En cas d'écart, la proposition fait foi.

Méthodes reprises des deux toolkits du répertoire : Situation / Complication / Question et pyramide de Minto, cadre « Entering a new market » (désirabilité, faisabilité, viabilité), barrières à l'entrée, matrice impact / effort, SWOT et matrice de risques.

---

## 1. Décision

**Construire un contrat de mise en pension (repo) : il prête des stablecoins contre des parts de fonds monétaire tokenisé, à toute heure, pour une durée et un taux fixes.**

Objectif poursuivi : **rendre les fonds monétaires tokenisés plus attractifs sur Stellar** en leur donnant un guichet de liquidité hors des heures ouvrées, financé par le marché.

Trois raisons :

1. **C'est la priorité annoncée.** La SDF, DTCC et Franklin Templeton désignent le collatéral et la liquidité comme le prochain usage des actifs tokenisés.
2. **L'espace est libre sur Stellar.** Aucun repo n'a été trouvé dans l'annuaire, les hackathons ou les dossiers SCF, alors que des réseaux concurrents s'y mettent.
3. **Le gain se chiffre.** Une réserve de précaution de 2 M$ coûte jusqu'à 67 400 $ par an ; le contrat ramène ce coût à quelques milliers de dollars.

---

## 2. Situation, complication, question

| | |
|---|---|
| **Situation** | Plus de 4 Md$ d'actifs réels tokenisés sont sur Stellar (fin août 2026), contre 1 Md$ en janvier. Les paiements du réseau fonctionnent 24h/24. |
| **Complication** | Les fonds n'ouvrent leur guichet de rachat qu'une fois par jour ouvré. Leurs détenteurs gardent donc à côté une réserve de stablecoins qui ne rapporte rien. |
| **Question** | Comment donner à ces fonds une liquidité permanente, sans que l'émetteur ait à la financer ? |

---

## 3. Le point de douleur

### 3.1 Un guichet par jour ouvré

| Fonds | Règle de rachat | Source |
|---|---|---|
| Spiko (EUTBL, USTBL) | Heure limite quotidienne, jours ouvrés. Retrait en stablecoins : « 1 à 2 jours ouvrés » | Support Spiko, fiches du fonds |
| BENJI (Franklin Templeton) | Jours ouvrés, aux heures ouvrées ; règlement à J+1 | Prospectus SEC |

Entre deux guichets, il s'écoule 24 heures en semaine et 72 heures le week-end, davantage avec un jour férié. Un besoin imprévu le vendredi après-midi n'est servi que le lundi ou le mardi.

### 3.2 Ce que font les autres

- **BUIDL (BlackRock) et USYC (Circle)** offrent un rachat instantané en USDC, grâce à une réserve financée par leur sponsor.
- **Spiko** a ajouté les dépôts et retraits en stablecoins, mais précise que cela ne change pas le fonctionnement du fonds.
- **BENJI** permet le transfert de parts entre détenteurs à toute heure, ce qui rend la pension techniquement possible, mais le rachat reste à J+1.

Le contrat apporte la sortie instantanée à tout fonds, avec l'argent de prêteurs du marché.

### 3.3 Pourquoi le besoin est naissant

| Signal | Date |
|---|---|
| Actifs réels sur Stellar : 1 Md$ → 3 Md$ → 4 Md$ ; plus de 19 000 détenteurs | janv., juin, août 2026 |
| Prix des actifs réels disponibles on-chain au standard SEP-40 (RedStone) : la brique qui manquait | mai à août 2026 |
| La SDF nomme la composabilité (collatéral et liquidité) comme prochaine priorité | 30 sept. 2026 |
| La CFTC admet les parts de fonds monétaires tokenisés comme marge | déc. 2025, sept. 2026 |
| Première pension de bons du Trésor contre USDC réglée un samedi, sur Canton (Bank of America, Citadel Securities, DTCC, Société Générale, Tradeweb) | 2025 |
| DBS, Franklin Templeton et Ripple annoncent la pension avec les parts sgBENJI comme collatéral, sur XRP Ledger | sept. 2025 |

Les deux derniers signaux montrent que le besoin est reconnu par de grands acteurs, sur des réseaux concurrents. Stellar est la chaîne d'origine de BENJI et n'a pas d'équivalent trouvé.

### 3.4 Pourquoi il est critique

- **Pour les régulateurs** : la BCE (bulletin d'avril 2026) et la Banque de France décrivent le décalage entre un token transférable 24h/24 et un fonds à guichet quotidien comme un risque de liquidité.
- **Pour les fonds** : ceux qui n'ont pas de sortie instantanée sont désavantagés face à BUIDL et USYC.
- **Pour les détenteurs** : un paiement qui ne peut pas partir avant lundi est un incident d'exploitation.

Limite à ne pas dépasser dans le pitch : le contrat répond à un besoin de liquidité, pas à une crise de confiance dans un fonds. Dans ce cas, les prêteurs retireraient leurs offres.

---

## 4. Retour sur investissement

### 4.1 Le principe

Le contrat fonctionne comme une assurance de liquidité : on ne paie que lorsqu'on s'en sert. Il vise la part **imprévisible** des besoins. Un besoin connu d'avance se couvre mieux par un rachat programmé au guichet du vendredi.

Gain annuel = réserve × rendement du fonds − montant emprunté × durée × taux de pension.

### 4.2 Cas type « PayCo » (illustratif)

| Hypothèse | Valeur | Origine |
|---|---|---|
| Réserve de précaution en stablecoins | 2 M$ | Hypothèse |
| Rendement net du fonds en dollars (USTBL) | 3,37 % | Résumé web, 5 oct. 2026 |
| Taux de pension, scénario bas | 5 % | SOFR (3,87 % au 1er oct. 2026) + 1,1 point |
| Taux de pension, scénario haut | 8 % | Hypothèse de prime hors heures ouvrées |
| Durée d'un emprunt de week-end | 64 heures | Vendredi 18 h à lundi 10 h |

Coût de la réserve aujourd'hui :

| Trésorier | Pratique | Coût annuel |
|---|---|---|
| Passif | Garde 2 M$ en stablecoins toute l'année | 67 400 $ |
| Actif | Rachète 2 M$ chaque vendredi, resouscrit chaque lundi | 28 800 $, sans couverture les nuits de semaine |

Avec le contrat, la réserve est placée dans le fonds et PayCo emprunte seulement en cas de besoin. Un week-end coûte 365 $ par million à 5 %, 584 $ à 8 %.

| PayCo emprunte 1 M$… | Gain net à 5 % | Gain net à 8 % |
|---|---|---|
| chaque week-end | + 48 400 $ | + 37 000 $ |
| un week-end sur deux | + 57 900 $ | + 52 200 $ |
| un week-end sur quatre | + 62 700 $ | + 59 800 $ |

Gain mesuré par rapport au trésorier passif. Scénario central retenu pour le pitch : un week-end sur deux à 8 %, soit **environ 52 000 $ par an**.

Seuil de rentabilité : même en empruntant toute la réserve chaque week-end, le contrat reste gagnant tant que le taux de pension est inférieur à 8,9 %.

### 4.3 Côté prêteur

Les stablecoins d'une offre permanente attendent d'être empruntés. Trois mécanismes rendent ce capital rentable :

- **Mutualisation** : une même offre sert plusieurs emprunteurs dont les imprévus ne tombent pas en même temps. Le total de stablecoins immobilisés diminue.
- **Rotation** : le prêteur peut détenir le fonds en semaine et ne passer en stablecoins que pour les fermetures.
- **Détenteurs naturels** : ceux qui reçoivent des stablecoins le week-end et ne peuvent pas les convertir en banque avant lundi (hypothèse non vérifiée).

| Taux de pension | Taux d'utilisation nécessaire pour battre le fonds |
|---|---|
| 5 % | 67 % |
| 8 % | 42 % |

Exemple : 1 M$ mis en offre chaque week-end, utilisé à 60 %, à 8 % : 18 200 $ par an, contre 12 800 $ si ce million était resté dans le fonds. C'est une activité à faible marge. Le taux de 5 % est probablement trop bas pour attirer des prêteurs.

### 4.4 Côté fonds

- Frais de gestion de Spiko : 0,25 % à 0,30 % par an selon les sources.
- Par client du type PayCo : 2 M$ d'encours en plus, soit 5 000 à 6 000 $ de frais annuels.
- Scénario de marché (hypothèse) : si 10 % du milliard de stablecoins en circulation sur Stellar sont des réserves de précaution, 100 M$ peuvent rejoindre les fonds, soit 3,4 M$ de rendement par an pour les détenteurs et 250 000 à 300 000 $ de frais pour les émetteurs.

### 4.5 Partage de la valeur, scénario central

| Acteur | Gain annuel par client PayCo |
|---|---|
| Détenteur | + 52 200 $ |
| Prêteur | 15 200 $ d'intérêts |
| Fonds | 5 000 à 6 000 $ de frais |

---

## 5. Pitch central

> « Sur Stellar, quatre milliards de dollars sont placés dans des fonds monétaires tokenisés. Ces fonds rapportent 3,4 % par an, mais leur guichet n'ouvre qu'une fois par jour ouvré. Le vendredi après-midi, votre argent est enfermé jusqu'à lundi.
>
> Alors chaque détenteur garde à côté une réserve de dollars numériques qui ne rapporte rien. Pour une société de paiement qui garde deux millions de côté, c'est 67 000 dollars perdus chaque année.
>
> Notre contrat ouvre un guichet de nuit. Vous déposez vos parts, vous recevez des dollars numériques en cinq secondes, et vous récupérez vos parts lundi à un prix fixé d'avance. Un week-end coûte quelques centaines de dollars par million. La réserve peut enfin être placée : environ 50 000 dollars de gain par an dans notre exemple.
>
> Les banques font cela entre elles chaque nuit : c'est la mise en pension. Bank of America et Citadel l'ont fait un samedi sur un réseau réservé aux institutions. DBS le prépare pour le fonds de Franklin Templeton sur un réseau concurrent. Sur Stellar, là où ce fonds est né, cela n'existe pas encore.
>
> Chacun y gagne : le détenteur place toute sa trésorerie, le prêteur est rémunéré contre des bons du Trésor, et le fonds attire plus d'encours. »

Phrase de différenciation : « deux parties, une durée fixe, un prix connu d'avance, et vous récupérez vos parts ».

---

## 6. Marché cible et acteurs

| Rôle | Qui | Ce qu'il gagne |
|---|---|---|
| **Emprunteur** | Tout détenteur de parts avec des sorties imprévisibles hors guichet. Exemple de démonstration : une société de paiement | Trésorerie placée à 100 %, liquidité à toute heure |
| **Prêteur** | Coffres de rendement (DeFindex, Sentora, Upshift), teneurs de marché, trésoreries | Rendement court terme contre un collatéral de qualité |
| **Émetteur du fonds** | Spiko, Franklin Templeton | Parts plus utiles, encours en hausse ; doit autoriser le contrat |
| **Fournisseur de prix** | RedStone, Reflector | Valorise le collatéral |

Le pitch ne dépend plus d'une hypothèse sur les sociétés de paiement : le client est le détenteur de parts, quel qu'il soit.

Hors cible : State Street SWEEP, qui offre déjà un accès continu aux stablecoins.

---

## 7. Hypothèses

| # | Hypothèse | Statut | Comment la lever |
|---|---|---|---|
| 1 | Les fonds se rachètent une fois par jour ouvré | Confirmée | — |
| 2 | Spiko et BENJI n'ont pas de sortie instantanée | Étayée (support Spiko, fiches BENJI) | Confirmer auprès de Spiko |
| 3 | Un contrat peut détenir ces parts | Faisable avec l'accord de l'émetteur | Spiko : tokens Soroban à permissions. BENJI : actif classique à autorisation |
| 4 | Le prix des parts est disponible on-chain | Partielle | Vérifier la liste des flux RedStone |
| 5 | Les détenteurs gardent une réserve de précaution significative | Non vérifiée | Entretiens à Meridian |
| 6 | Des prêteurs s'engagent hors heures ouvrées | Non vérifiée | Entretien avec un gestionnaire de coffre |
| 7 | Le taux de pension se situe entre 5 % et 8 % | Hypothèse | Dépend de l'utilisation des offres |
| 8 | Aucun repo sur Stellar | Non trouvé dans les sources consultées | — |

---

## 8. Concurrence et voisins

| Projet | Ce qu'il fait | Différence |
|---|---|---|
| **Octarine** (SCF n° 44, actif) | Rachète la part avec une décote, puis attend le guichet du fonds | Proche cousin. Avec la pension, on garde sa position et le coût est connu d'avance. Complémentaire : voie de sortie pour un prêteur après un défaut |
| **Prêt à pools** (Blend, Templar, Mystic, Legasi) | Prêt à taux variable contre collatéral. USDY (Ondo) y est éligible depuis août 2026 | Taux variable, pas de terme ; les parts de fonds régulés à permissions n'y sont pas, à ma connaissance |
| **Clear** | Liquidité instantanée pour sociétés de paiement, apportée par des garants | Sans collatéral en fonds tokenisés |
| **Hors Stellar** | Canton (pension de bons du Trésor), XRP Ledger (DBS et sgBENJI) | Réseaux institutionnels ou bancaires ; ici, un contrat ouvert sur une chaîne de paiement publique |

La nouveauté est sur Stellar, pas dans le monde : la pension on-chain existe ailleurs.

---

## 9. Cadre du contrat

### 9.1 Décisions prises

| Sujet | Décision |
|---|---|
| Liquidité | Offres permanentes : le prêteur dépose ses stablecoins dans une offre (taux, durée maximale, fonds acceptés) ; l'emprunteur la prend en une transaction |
| Collatéral | Deux fonds de test, euro et dollar, contre deux stablecoins |
| Périmètre | Contrat, tests, déploiement testnet et interface web minimale |
| Chiffres du pitch | Cas type illustratif (section 4) |

### 9.2 Cycle de vie

| Étape | Qui | Ce qui se passe |
|---|---|---|
| Offre | Prêteur | Dépose des stablecoins avec ses conditions |
| Ouverture | Emprunteur | Bloque ses parts, reçoit les stablecoins dans la même transaction |
| Rachat | Emprunteur | Rembourse le principal et l'intérêt, récupère ses parts |
| Défaut | Prêteur | Après l'échéance, saisit les parts |
| Retrait | Prêteur | Reprend les stablecoins non utilisés de son offre |

### 9.3 Choix proposés pour la spécification (à confirmer)

- **Décote par fonds** : le prêt est plafonné sous la valeur des parts (par exemple 98 %).
- **Durée courte** : sept jours au plus, donc pas d'appel de marge dans la première version.
- **Rachat anticipé autorisé**, intérêt calculé au prorata du temps.
- **Prix** : interface SEP-40, avec un oracle de test sur testnet.
- **Registre des fonds acceptés** tenu par un administrateur.
- **Contrat upgradable** par son administrateur.
- **Défaut** : le prêteur doit être autorisé à détenir les parts saisies. Sinon, le contrat doit pouvoir les présenter au rachat du fonds. Point à trancher.

### 9.4 Scalabilité

Deux audits de protocoles de prêt sur Stellar (Slender, Peridot) relèvent le même défaut : une liquidation qui parcourt toutes les positions dépasse les limites de ressources du réseau et se bloque.

- **Une pension = une entrée de stockage.** Chaque opération touche un nombre fixe d'entrées.
- **Aucune boucle sur l'ensemble des positions ou des offres.**
- **Pensions courtes**, donc loyer de stockage faible.

À démontrer : un test qui ouvre un grand nombre de pensions et montre un coût par opération constant. Ce sont des intentions de conception, pas encore des mesures.

### 9.5 Évolutivité

| Version | Contenu |
|---|---|
| 1 (hackathon) | Pension bilatérale à terme fixe, offres permanentes, deux fonds |
| 2 | Carnet d'offres avec meilleure exécution, renouvellement automatique |
| 3 | Appels de marge, parts de prêteur tokenisées (SEP-56) |
| 4 | Garantie à première demande sur le même moteur de collatéral |

Points d'extension : tout token SEP-41, tout oracle SEP-40, mise à niveau du code.

---

## 10. Risques

| Risque | Probabilité | Gravité | Réponse |
|---|---|---|---|
| L'émetteur refuse d'autoriser le contrat | Moyenne | Haute | Tokens de test sur testnet ; argument d'encours pour l'émetteur |
| Pas assez de prêteurs, ou taux trop élevé | Moyenne | Haute | Le gain reste positif jusqu'à 8,9 % ; mutualisation et rotation |
| Le rendement d'un fonds est versé en nouvelles parts au détenteur, donc au contrat (cas BENJI) | Haute | Moyenne | Version 1 calée sur le modèle Spiko ; cas BENJI traité dans la spécification |
| Prix de la part figé le week-end | Moyenne | Faible | Décote ; la valeur d'un fonds de bons du Trésor varie très peu sur sept jours |
| Crise de confiance dans un fonds | Faible | Haute | Hors du champ du contrat ; à dire clairement |
| Qualification juridique de la pension et des transferts de parts régulées | Inconnue | Haute | Hors périmètre du hackathon |
| Règles du hackathon sur le code écrit avant l'événement | Inconnue | Haute | Non publiées ; à vérifier auprès des organisateurs |

---

## 11. Contrôle de cohérence (5 octobre 2026)

| # | Constat | Correction |
|---|---|---|
| 1 | Le cas chiffré supposait un emprunt chaque week-end. Un besoin aussi prévisible se couvre mieux par un rachat le vendredi | Le contrat est positionné sur l'imprévu ; tableau de sensibilité et deux situations de départ |
| 2 | Les offres permanentes déplacent la réserve dormante vers le prêteur | Section 4.3 : mutualisation, rotation, seuils d'utilisation |
| 3 | « 76 % du temps fermé » mélangeait heures de bureau et règle de rachat | Remplacé par « un guichet par jour ouvré, 24 à 72 heures entre deux guichets » |
| 4 | Le taux de pension de 5 % n'avait pas de source | Ancré sur le SOFR ; scénario à 8 % ajouté |
| 5 | La différence avec Octarine était surestimée | Reformulée : proche cousin, complémentaire |
| 6 | Le persona « société de paiement » reposait sur une hypothèse non vérifiée | Le client est le détenteur de parts ; la société de paiement devient l'exemple |
| 7 | « Le prêteur gagne 5 % » ignorait le taux d'utilisation | Rendement du prêteur recalculé |
| 8 | L'idée était présentée comme nouvelle sans précision | Nouvelle sur Stellar ; elle existe sur Canton et se prépare sur XRP Ledger |

Ce qui tient : les trois critères de choix (espace libre sur Stellar, priorité annoncée, marché propice) et le cap d'attractivité des fonds.

---

## 12. Idées écartées

| Idée | Raison |
|---|---|
| Garantie à première demande collatéralisée | Espace vide, mais aucune demande exprimée par les institutions ; gardée pour la version 4 |
| Dépôt de garantie locatif rémunéré | Variante grand public, moins nouvelle |
| Escrow de commerce international | Occupé (Trustless Work, Kutana, CashAbroad) |
| Escrow pour agents IA | Saturé (171 soumissions de hackathon) |
| Assurance paramétrique | Financée ailleurs (Sentinel), données d'oracle manquantes |
| Tontine, crédits carbone | Occupés |

---

## 13. Contexte de marché

| Indicateur | Valeur | Date | Source |
|---|---|---|---|
| Actifs réels tokenisés sur Stellar | > 4 Md$, 70 actifs, > 19 000 détenteurs | août 2026 | Lumen Loop |
| Stablecoins en circulation sur Stellar | > 1 Md$ | 5 sept. 2026 | Lumen Loop |
| Volume de stablecoins | 11,4 Md$ au T2 2026 | juil. 2026 | Lumen Loop (webinaire SDF) |
| Spiko sur Stellar | environ 600 M$ | mai 2026 | Token Terminal via Lumen Loop |
| EUTBL (toutes chaînes) | environ 1 Md$, 3 810 détenteurs, 2,09 % net | 5 oct. 2026 | RWA.xyz (résumé web) |
| USTBL | 3,37 % net | 5 oct. 2026 | Résumé web |
| BENJI sur Stellar | 426,9 M de parts, 1 001 détenteurs | 29 sept. 2026 | Scout / stellar.expert |
| SOFR | 3,87 % | 1er oct. 2026 | Résumé web |

Réserves : une autre source donne 2,5 Md$ pour BENJI sur Stellar, non réconcilié. Les sources divergent sur DTCC (lancement le 15 juillet 2026, ou disponibilité au premier semestre 2027). Les chiffres marqués « résumé web » ne sont pas vérifiés à la source. La date de la pension sur Canton vient de ma mémoire, pas des sources consultées.

HackMeridian : pistes *Genesis* (idée → MVP) et *Scale* (prototype → produit), jusqu'à 30 000 $ en XLM, 3 minutes de présentation.

---

## 14. Sources

**Stellar (serveur MCP stellar-raven, consulté le 5 octobre 2026)**

- Scout / stellarlight.xyz : annuaire, vides par verticale, TVL, SCF, RFP, soumissions de hackathon, registre d'audits
- Lumen Loop : [roundup du 2 oct. 2026](https://lumenloop.com/research/stellar-weekly-roundup-week-sep-25-2026), [roundup du 11 sept. 2026](https://lumenloop.com/research/stellar-weekly-roundup-week-sep-4-2026), [roundup du 4 sept. 2026](https://lumenloop.com/research/stellar-weekly-roundup-week-aug-28-2026), [roundup du 28 août 2026](https://lumenloop.com/research/stellar-weekly-roundup-week-aug-21-2026), [roundup du 31 juil. 2026](https://lumenloop.com/research/stellar-weekly-roundup-week-jul-24-2026), [roundup du 22 mai 2026](https://lumenloop.com/research/stellar-weekly-roundup-week-15-2026), [USDY et SEP-40](https://lumenloop.com/news/redstone-brings-ondo-usdy-stellar-defi-sep-40-integration), [Stellar and RWAs](https://lumenloop.com/research/stellar-rwas)
- Blog SDF : [Not all tokenized securities are created the same](https://stellar.org/blog/ecosystem/not-all-tokenized-securities-are-created-the-same)
- Documentation : [stratégies de stockage](https://developers.stellar.org/docs/build/guides/storage/storage-strategies), [mise à niveau des contrats](https://developers.stellar.org/docs/build/guides/conventions/upgrading-contracts), [autorisation des soldes SAC](https://developers.stellar.org/docs/tokens/stellar-asset-contract#balance-authorization-required), [frais et limites](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering)
- Standards : [SEP-40](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0040.md), [SEP-56](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0056.md), [SEP-57](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0057.md)
- Audits : [Spiko — Halborn](https://stellarsecurityportal.com/report/66), [Slender — Certora](https://stellarsecurityportal.com/report/24), [Peridot — Halborn](https://stellarsecurityportal.com/report/83)
- [Octarine — dossier SCF n° 44](https://communityfund.stellar.org/submissions/recbRpXosPJ3lhhgr)

**Hors Stellar**

- [BCE — Tokenised money market funds: new technology, familiar risks?](https://www.ecb.europa.eu/press/financial-stability-publications/macroprudential-bulletin/html/ecb.mpbu202604_04.en.html)
- [Banque de France — Tokenised money market funds and financial stability](https://www.banque-france.fr/en/publications-and-statistics/publications/tokenised-money-market-funds-what-are-implications-financial-stability)
- [Prospectus Franklin OnChain U.S. Government Money Fund (SEC)](https://www.sec.gov/Archives/edgar/data/1786958/000137949121001250/filing222856581.htm) · [BENJI Deep Dive 2026](https://eco.com/support/en/articles/15254016-benji-deep-dive-2026-franklin-templeton-s-tokenized-money-market)
- Spiko : [dépôts et retraits en stablecoins (support)](https://support.spiko.io/hc/en-us/articles/48258319997713-Deposit-and-withdraw-with-stablecoins), [annonce](https://www.spiko.io/blog/spiko-launches-stablecoin-deposits-and-withdrawals), [Cointelegraph](https://cointelegraph.com/news/spiko-coinbase-stablecoin-payments-treasury-funds), [fonds en euros](https://www.spiko.io/spiko-treasury-bills-euro), [EUTBL sur RWA.xyz](https://app.rwa.xyz/assets/EUTBL), [fiche EUTBL — Usual](https://docs.usual.money/resources-and-ecosystem/fact-sheets/collateral-assets/eutbl-spiko)
- [BUIDL Deep Dive 2026](https://eco.com/support/en/articles/15254013-buidl-deep-dive-2026) · [USYC — Circle](https://www.circle.com/usyc)
- Pension sur Canton : [Tradeweb](https://www.tradeweb.com/newsroom/media-center/in-the-news/digital-asset-and-industry-working-group-complete-groundbreaking-on-chain-us-treasury-financing-on-canton-network/), [CryptoSlate](https://cryptoslate.com/us-treasuries-trade-on-saturday-as-banks-join-canton-blockchain-settlement-test/)
- DBS, Franklin Templeton, Ripple : [communiqué Ripple](https://ripple.com/ripple-press/dbs-franklin-templeton-to-launch-trading-and-lending-solutions-tokenised-mmf-ripple-stablecoin-rlusd/), [The Block](https://www.theblock.co/post/371200/dbs-franklin-templeton-ripple)
- [SOFR — octobre 2026](https://www.sofrrate.com/sofr-rate/2026-10) · [SOFR — FRED](https://fred.stlouisfed.org/series/SOFR)
- [Fipto et Spiko](https://internationalfintech.com/fipto-partners-with-spiko-to-let-treasurers-earn-a-return-on-idle-treasury-balances/)
- [hackmeridian.com](https://www.hackmeridian.com/)

**Méthode**

- `595045484-2-Management-Consulting-Toolkit-Overview-and-Approach.pdf` (48 pages)
- `Mckinsey-Delloite-toolkit-templates.pdf` (131 pages)
