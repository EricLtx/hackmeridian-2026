// French translations of src/guide.js, keyed by the English source text.
export default {
  "I hold fund shares and need cash": "Je détiens des parts de fonds et j'ai besoin de liquidités",
  "I lend stablecoins": "Je prête des stablecoins",
  "I issue a fund": "J'émets un fonds",
  "You keep your {sym} shares and their yield. You lock them in the contract and receive {code} in the same transaction, at any hour, for a term you choose.":
    "Vous conservez vos parts {sym} et leur rendement. Vous les bloquez dans le contrat et recevez des {code} dans la même transaction, à toute heure, pour la durée de votre choix.",
  "Freighter set to Testnet, with a little XLM for network fees.": "Freighter réglé sur Testnet, avec un peu de XLM pour les frais de réseau.",
  "A trustline to {code}, added from the wallet card.": "Une trustline vers {code}, ajoutée depuis la carte du portefeuille.",
  "{sym} shares in your wallet, and your address on the fund issuer's allowlist: the issuer decides who may hold its shares.":
    "Des parts {sym} dans votre portefeuille, et votre adresse sur la liste d'autorisation de l'émetteur du fonds : l'émetteur décide qui peut détenir ses parts.",
  "Pick an offer: the one the issuer designates comes first, then the cheapest.": "Choisissez une offre : celle que l'émetteur désigne vient en premier, puis la moins chère.",
  "Choose the shares to lock and the term, from one hour to {term}. The page shows the most you can borrow after the fund's haircut, and what you will owe.":
    "Choisissez les parts à bloquer et la durée, d'une heure à {term}. La page indique le maximum que vous pouvez emprunter après la décote du fonds, et ce que vous devrez.",
  "Choose the shares to lock and the term, from one hour to {term}. The page shows the most you can borrow after the {rate} haircut, and what you will owe.":
    "Choisissez les parts à bloquer et la durée, d'une heure à {term}. La page indique le maximum que vous pouvez emprunter après la décote de {rate}, et ce que vous devrez.",
  "Sign once. If the contract would refuse (too large, stale price, paused), the page tells you before you sign.":
    "Signez une seule fois. Si le contrat devait refuser (montant trop élevé, prix périmé, suspension), la page vous le dit avant la signature.",
  "Repurchase whenever you want: principal plus interest for the started hours, with a minimum of one hour. Your shares come back in the same transaction.":
    "Rachetez quand vous voulez : le principal plus les intérêts des heures entamées, avec un minimum d'une heure. Vos parts reviennent dans la même transaction.",
  "Fixed rate, fixed term, no margin call: nothing is liquidated before the term, whatever the price does.":
    "Taux fixe, durée fixe, pas d'appel de marge : rien n'est liquidé avant l'échéance, quelle que soit l'évolution du prix.",
  "After the term the lender may take the shares; until it does, you can still repurchase.":
    "Après l'échéance, le prêteur peut prendre les parts ; tant qu'il ne l'a pas fait, vous pouvez encore racheter.",
  "A pause of the contract never blocks a repurchase. If the issuer freezes your shares, your debt still settles and the shares are delivered when the issuer allows.":
    "Une suspension du contrat ne bloque jamais un rachat. Si l'émetteur gèle vos parts, votre dette est tout de même réglée et les parts sont livrées dès que l'émetteur l'autorise.",
  "Cost: the interest, and the network fee of each transaction (well under 1 XLM). The contract charges no fee of its own.":
    "Coût : les intérêts, et les frais de réseau de chaque transaction (bien moins de 1 XLM). Le contrat ne prélève aucun frais propre.",
  "You deposit {code} in an offer with your rate and longest term. Borrowers draw on it against shares of the funds you list; what is not borrowed stays yours to withdraw at any time.":
    "Vous déposez des {code} dans une offre, avec votre taux et votre durée maximale. Les emprunteurs y puisent contre des parts des fonds que vous listez ; ce qui n'est pas emprunté reste à vous et se retire à tout moment.",
  "An approval by each fund's issuer: you sign an attestation, the issuer approves your address for its fund.":
    "Un agrément de l'émetteur de chaque fonds : vous signez une attestation, l'émetteur agrée votre adresse pour son fonds.",
  "A trustline to {code} and the stablecoins to lend.": "Une trustline vers {code} et les stablecoins à prêter.",
  "On an instance fixed to a single lender, only that address may create offers.": "Sur une instance réservée à un prêteur unique, seule cette adresse peut créer des offres.",
  "Create an offer: amount, annual rate, longest term (up to {term}), the funds it accepts (up to eight).":
    "Créez une offre : montant, taux annuel, durée maximale (jusqu'à {term}), fonds acceptés (huit au plus).",
  "Each repurchase returns principal and interest to your offer; withdraw any unlent amount whenever you want, even while the contract is paused.":
    "Chaque rachat reverse le principal et les intérêts à votre offre ; retirez tout montant non prêté quand vous voulez, même pendant une suspension du contrat.",
  "If a borrower has not repurchased by the term, take the shares: they go to your address or to another address the issuer approved.":
    "Si un emprunteur n'a pas racheté à l'échéance, prenez les parts : elles vont à votre adresse ou à une autre adresse agréée par l'émetteur.",
  "The loan never exceeds the share value after the fund's haircut; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.":
    "Le prêt ne dépasse jamais la valeur des parts après la décote du fonds ; le prix vient du flux de VL propre au fonds, contrôlé par un corridor et refusé s'il est périmé.",
  "The loan never exceeds the share value after the {rate} haircut; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.":
    "Le prêt ne dépasse jamais la valeur des parts après la décote de {rate} ; le prix vient du flux de VL propre au fonds, contrôlé par un corridor et refusé s'il est périmé.",
  "You carry the credit risk inside the haircut and your own reserve; the contract holds no buffer and sells nothing for you.":
    "Vous portez le risque de crédit dans la décote et dans votre propre réserve ; le contrat ne détient aucun coussin et ne vend rien pour vous.",
  "Rate floors, caps and feeds change only through a time delay you can see on this page.":
    "Les planchers de taux, les plafonds et les flux ne changent qu'après un délai de gouvernance visible sur cette page.",
  "Your fund is admitted as data: its share token, NAV feed, haircut, limits. You never lend against your own fund; you keep the controls an issuer needs.":
    "Votre fonds est admis comme une donnée : son jeton de part, son flux de VL, sa décote, ses limites. Vous ne prêtez jamais contre votre propre fonds ; vous gardez les contrôles dont un émetteur a besoin.",
  "A SEP-41 share token with an allowlist (a classic Stellar asset with authorization flags works), and a SEP-40 NAV feed published at a known cadence.":
    "Un jeton de part SEP-41 avec liste d'autorisation (un actif Stellar classique avec drapeaux d'autorisation convient), et un flux de VL SEP-40 publié à une cadence connue.",
  "A steward key for the fund, and a registered backup key.": "Une clé de gestion du fonds (steward), et une clé de secours enregistrée.",
  "Admit the fund with the governor: two signatures on one call.": "Faites admettre le fonds avec le gouverneur : deux signatures sur un même appel.",
  "Approve the lenders who may lend against your fund, after their attestation; revoke at will.":
    "Agréez les prêteurs autorisés à prêter contre votre fonds, après leur attestation ; révoquez-les à volonté.",
  "Tune the haircut and the caps inside the risk envelope; lower the NAV reference when the fund distributes; freeze the fund if you must.":
    "Ajustez la décote et les plafonds dans l'enveloppe de risque ; abaissez la référence de VL quand le fonds distribue ; gelez le fonds si nécessaire.",
  "Any loosening of a limit waits {delay}; a tightening applies at once.": "Tout assouplissement d'une limite attend {delay} ; un resserrement s'applique immédiatement.",
  "If your token refuses a transfer during a repo, the debt still settles and the shares are recorded for later delivery: no exit is ever blocked.":
    "Si votre jeton refuse un transfert pendant un repo, la dette est tout de même réglée et les parts sont enregistrées pour une livraison ultérieure : aucune sortie n'est jamais bloquée.",
  "The contract never lends your fund's shares and never sells them: a defaulted repo hands the shares to an address you approved.":
    "Le contrat ne prête jamais les parts de votre fonds et ne les vend jamais : un repo en défaut remet les parts à une adresse que vous avez agréée.",
  "Loan currency": "Devise du prêt",
  "MiCA-allowlisted stablecoins only; several tokens of one currency share one cap":
    "uniquement des stablecoins autorisés au titre de MiCA ; plusieurs jetons d'une même devise partagent un plafond",
  "Funds admitted": "Fonds admis",
  "{symbol}: {haircut} haircut plus {fxHaircut} on the exchange rate, {total} in all; NAV in {currency} through an exchange-rate feed, at most {age} old":
    "{symbol} : décote de {haircut} plus {fxHaircut} sur le taux de change, soit {total} au total ; VL en {currency} via un flux de taux de change, datant d'au plus {age}",
  "; ": " ; ",
  "{symbol}: {haircut} haircut, NAV in {currency} through an exchange-rate feed, NAV at most {age} old":
    "{symbol} : décote de {haircut}, VL en {currency} via un flux de taux de change, VL datant d'au plus {age}",
  "{symbol}: {haircut} haircut, NAV in {currency}, NAV at most {age} old": "{symbol} : décote de {haircut}, VL en {currency}, VL datant d'au plus {age}",
  "each fund has its own issuer, feed, haircut and caps": "chaque fonds a son émetteur, son flux, sa décote et ses plafonds",
  "Caps": "Plafonds",
  "{perRepo} per repo, {perFund} per fund ({symbol}), {currencyCap} for the currency": "{perRepo} par repo, {perFund} par fonds ({symbol}), {currencyCap} pour la devise",
  "{perRepo} per repo, {perFund} per fund ({symbol})": "{perRepo} par repo, {perFund} par fonds ({symbol})",
  "exposure grows only through the time delay": "l'exposition n'augmente qu'après le délai de gouvernance",
  "Interest": "Intérêts",
  "the offer's annual rate, charged per started hour, one hour at least": "le taux annuel de l'offre, facturé par heure entamée, une heure au minimum",
  "actual/365; rounded up to the unit in the lender's favor": "exact/365 ; arrondi à l'unité supérieure en faveur du prêteur",
  "Term": "Durée",
  "one hour to {term}": "d'une heure à {term}",
  "early repurchase allowed; after the term the lender may take the shares": "rachat anticipé autorisé ; après l'échéance, le prêteur peut prendre les parts",
  "Changes": "Changements",
  "{delay} time delay on upgrades, feed changes and any loosening": "délai de gouvernance de {delay} sur les mises à niveau, les changements de flux et tout assouplissement",
  "cancellable by the guardian or the sentinel; tightening is immediate": "annulable par le gardien ou la sentinelle ; un resserrement est immédiat",
  "Pause": "Suspension",
  "paused: no new offer or repo": "suspendu : ni nouvelle offre ni nouveau repo",
  "open": "ouvert",
  "a pause never blocks repurchase, withdrawal, seizure or delivery": "une suspension ne bloque jamais rachat, retrait, saisie ou livraison",
  "Network": "Réseau",
  "{network}, contract version {version}": "{network}, version {version} du contrat",
  "no real value; the code is not externally audited yet": "aucune valeur réelle ; le code n'est pas encore audité par un tiers",
};
