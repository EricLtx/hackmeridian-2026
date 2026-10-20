// French translations of src/chain.js, keyed by the English source text.
export default {
  "RPC returned no ledger close time": "Le RPC n'a renvoyé aucune heure de clôture de ledger",
  "Friendbot refused ({status}).": "Friendbot a refusé ({status}).",
  "Waiting for your signature in the wallet.": "En attente de votre signature dans le portefeuille.",
  "The wallet did not sign.": "Le portefeuille n'a pas signé.",
  "Checking the transaction with the network.": "Vérification de la transaction auprès du réseau.",
  "Preparing the transaction.": "Préparation de la transaction.",
  "Confirmed in {seconds} s.": "Confirmée en {seconds} s.",
  "Result: {code}.": "Résultat : {code}.",
  "Sending to the network.": "Envoi au réseau.",
  "Code: {code}.": "Code : {code}.",
  "No receipt from the network yet. Sending again. It can still land until {until}.":
    "Pas encore d'accusé de réception du réseau. Nouvel envoi. La transaction peut encore être inscrite jusqu'à {until}.",
  "Submitted. Waiting for the next ledger.": "Envoyée. En attente du prochain ledger.",
  "Still waiting. It can land until {until}; it is not failed before then.":
    "Toujours en attente. La transaction peut être inscrite jusqu'à {until} ; elle n'a pas échoué d'ici là.",
  "The network asked for an unusually high fee ({fee} XLM). Nothing was signed.": "Le réseau a demandé des frais inhabituellement élevés ({fee} XLM). Rien n'a été signé.",
  "The fee of the prepared transaction does not match the network's estimate. Nothing was signed.":
    "Les frais de la transaction préparée ne correspondent pas à l'estimation du réseau. Rien n'a été signé.",
  "Submitted, confirming: waiting for a second RPC endpoint ({host}) to see it.":
    "Envoyée, confirmation en cours : en attente qu'un second point d'accès RPC ({host}) la voie.",
  "{host} reports it failed.": "{host} la signale comme échouée.",
  "{host} does not know it, and its validity window has passed.": "{host} ne la connaît pas, et sa fenêtre de validité est passée.",
  "{host} did not confirm it in time.": "{host} ne l'a pas confirmée à temps.",
  "RPC {from} did not answer in time: switched to {to}.": "Le RPC {from} n'a pas répondu à temps : bascule vers {to}.",
  "RPC {from} is {n} ledgers behind: switched to {to}.": "Le RPC {from} a {n} ledgers de retard : bascule vers {to}.",
  "RPC {to} has caught up: switched back to it.": "Le RPC {to} est de nouveau à jour : retour vers lui.",
  "RPC {from} failed: switched to {to}.": "Le RPC {from} a échoué : bascule vers {to}.",
};
