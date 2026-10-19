// French translations of src/errors.js, keyed by the English source text.
export default {
  "This function is not available in this contract version.": "Cette fonction n'est pas disponible dans cette version du contrat.",
  "These fund shares are not accepted as collateral.": "Ces parts de fonds ne sont pas acceptées en garantie.",
  "The haircut setting of this fund is invalid.": "Le réglage de décote de ce fonds n'est pas valide.",
  "Amounts must be greater than zero.": "Les montants doivent être supérieurs à zéro.",
  "The term is outside what is allowed.": "La durée sort de ce qui est autorisé.",
  "Choose {term}.": "Choisissez une durée de {term}.",
  "The minimum is 1 hour.": "Le minimum est d'une heure.",
  "The price feed has no price for this fund right now.": "Le flux de prix n'a pas de prix pour ce fonds en ce moment.",
  "The contract is not configured.": "Le contrat n'est pas configuré.",
  "New loans and new offers are paused. Repurchases and withdrawals still work.":
    "Les nouveaux prêts et les nouvelles offres sont suspendus. Les rachats et les retraits fonctionnent toujours.",
  "This stablecoin is not accepted by the contract.": "Ce stablecoin n'est pas accepté par le contrat.",
  "The fund and the stablecoin are in different currencies.": "Le fonds et le stablecoin sont dans des devises différentes.",
  "The fund price or the exchange rate is too old to lend against. It works again after the next publication.":
    "Le prix du fonds ou le taux de change est trop ancien pour servir de base à un prêt. Le prêt redevient possible après la prochaine publication.",
  "The latest price is outside its plausible range, so the contract refuses to lend against it.":
    "Le dernier prix sort de sa plage plausible : le contrat refuse de prêter sur cette base.",
  "This is more than the shares can secure.": "C'est plus que ce que les parts peuvent garantir.",
  "The maximum is {max}.": "Le maximum est de {max}.",
  "This offer does not exist.": "Cette offre n'existe pas.",
  "The offer does not hold enough for this amount.": "L'offre ne contient pas assez pour ce montant.",
  "It holds {available}.": "Elle contient {available}.",
  "This position does not exist.": "Cette position n'existe pas.",
  "This position is already closed.": "Cette position est déjà close.",
  "This position has not reached its term yet.": "Cette position n'a pas encore atteint son échéance.",
  "You can take the shares from {when}.": "Vous pourrez prendre les parts à partir de {when}.",
  "This loan would go over a limit: per loan, per fund or for the whole currency. Try a smaller amount.":
    "Ce prêt dépasserait une limite : par prêt, par fonds ou pour toute la devise. Essayez un montant plus petit.",
  "An offer must list between one and eight different funds.": "Une offre doit lister entre un et huit fonds différents.",
  "Seized shares can only go to a lender the fund issuer approves, and your address is not approved for this fund any more. Ask the issuer to approve it again, then retry.":
    "Les parts saisies ne peuvent aller qu'à un prêteur agréé par l'émetteur du fonds, et votre adresse n'est plus agréée pour ce fonds. Demandez à l'émetteur de l'agréer de nouveau, puis réessayez.",
  "Your address is not an approved lender for this fund. The fund issuer approves lenders.":
    "Votre adresse n'est pas celle d'un prêteur agréé pour ce fonds. C'est l'émetteur du fonds qui agrée les prêteurs.",
  "The lender of this offer is no longer approved by the fund issuer. Pick another offer.":
    "Le prêteur de cette offre n'est plus agréé par l'émetteur du fonds. Choisissez une autre offre.",
  "A token transfer did not move the exact amount expected.": "Un transfert de jeton n'a pas déplacé exactement le montant attendu.",
  "This offer does not accept these fund shares.": "Cette offre n'accepte pas ces parts de fonds.",
  "The rate must be between 0 % and 100 % a year.": "Le taux doit être compris entre 0 % et 100 % par an.",
  "These amounts are too large to compute.": "Ces montants sont trop grands pour être calculés.",
  "A setting lies outside the protocol risk limits.": "Un réglage sort de l'enveloppe de risque du protocole.",
  "The fund issuer has suspended new loans on this fund.": "L'émetteur du fonds a suspendu les nouveaux prêts sur ce fonds.",
  "The price feed returned an invalid price.": "Le flux de prix a renvoyé un prix non valide.",
  "The fund is listed twice in the offer.": "Le fonds figure deux fois dans l'offre.",
  "This wallet does not hold the role this action needs.": "Ce portefeuille n'a pas le rôle que cette action exige.",
  "The fund's two price feeds disagree, so no loan is priced until they agree again.":
    "Les deux flux de prix du fonds divergent : aucun prêt n'est évalué tant qu'ils ne concordent pas de nouveau.",
  "The fund issuer still refuses the transfer of these shares. They stay reserved for you; retry once the issuer lifts its block.":
    "L'émetteur du fonds refuse toujours le transfert de ces parts. Elles restent réservées pour vous ; réessayez une fois le blocage levé par l'émetteur.",
  "No shares are waiting for release on this repo.": "Aucune part n'attend d'être libérée sur ce repo.",
  "This change is waiting for its time delay to pass.": "Ce changement attend la fin de son délai de gouvernance.",
  "This instance is run by a single lender: only that lender can make offers here.":
    "Cette instance est gérée par un prêteur unique : seul ce prêteur peut y faire des offres.",
  "The fund's issuer cannot lend against its own fund.": "L'émetteur du fonds ne peut pas prêter contre son propre fonds.",
  "The issuer must record this lender's declaration before approving it.":
    "L'émetteur doit enregistrer l'attestation de ce prêteur avant de l'agréer.",
  "The exchange-rate band of this fund would be wider than its exchange-rate haircut, which the contract refuses.":
    "La bande de taux de change de ce fonds serait plus large que sa décote de change, ce que le contrat refuse.",
  "The sentinel must be a key that holds no other role.": "La sentinelle doit être une clé qui n'a aucun autre rôle.",
  "The contract's stored records are already at the current version.": "Les enregistrements stockés du contrat sont déjà à la version actuelle.",
  "The contract was just upgraded and its stored records are not migrated yet: new loans and offers resume once the governor migrates them. Repurchases, withdrawals and deliveries still work.":
    "Le contrat vient d'être mis à niveau et ses enregistrements ne sont pas encore migrés : les nouveaux prêts et les nouvelles offres reprennent dès que le gouverneur les migre. Les rachats, les retraits et les livraisons fonctionnent toujours.",
  "This wallet is not on the fund's allowlist.": "Ce portefeuille ne figure pas sur la liste d'autorisation du fonds.",
  "Ask the operator to run: {command}": "Demandez à l'opérateur d'exécuter : {command}",
  "Ask the operator to onboard it.": "Demandez à l'opérateur de l'inscrire.",
  "The fund issuer has frozen the shares of this wallet.": "L'émetteur du fonds a gelé les parts de ce portefeuille.",
  "You hold fewer fund shares than this.": "Vous détenez moins de parts de fonds que cela.",
  "This account does not exist on testnet yet. Fund it with test XLM first.":
    "Ce compte n'existe pas encore sur le testnet. Approvisionnez-le d'abord en XLM de test.",
  "Your {code} balance is too low for this.": "Votre solde en {code} est trop bas pour cette opération.",
  "Your {code} trustline is not authorized by the issuer.": "Votre trustline {code} n'est pas autorisée par l'émetteur.",
  "This wallet has no {code} trustline. Use \"Add {code}\" first.": "Ce portefeuille n'a pas de trustline {code}. Utilisez d'abord « Ajouter {code} ».",
  "The price feed refused the operation.": "Le flux de prix a refusé l'opération.",
  "A contract refused the operation.": "Un contrat a refusé l'opération.",
  "A token contract refused the operation.": "Un contrat de jeton a refusé l'opération.",
  "The transaction expired before it landed. Nothing changed on chain. You can try again.":
    "La transaction a expiré avant d'être inscrite. Rien n'a changé sur la chaîne. Vous pouvez réessayer.",
  "The network refused the transaction. Nothing changed on chain.": "Le réseau a refusé la transaction. Rien n'a changé sur la chaîne.",
  "The transaction failed on chain. Nothing changed.": "La transaction a échoué sur la chaîne. Rien n'a changé.",
  "The network did not answer. Check your connection and try again.": "Le réseau n'a pas répondu. Vérifiez votre connexion et réessayez.",
  "Something went wrong.": "Une erreur s'est produite.",
};
