// Spanish translations of src/chain.js, keyed by the English source text.
export default {
  "RPC returned no ledger close time": "El RPC no devolvió la hora de cierre del ledger",
  "Friendbot refused ({status}).": "Friendbot rechazó la solicitud ({status}).",
  "Waiting for your signature in the wallet.": "Esperando su firma en la billetera.",
  "The wallet did not sign.": "La billetera no firmó.",
  "Checking the transaction with the network.": "Comprobando la transacción con la red.",
  "Preparing the transaction.": "Preparando la transacción.",
  "Confirmed in {seconds} s.": "Confirmada en {seconds} s.",
  "Result: {code}.": "Resultado: {code}.",
  "Sending to the network.": "Enviando a la red.",
  "Code: {code}.": "Código: {code}.",
  "No receipt from the network yet. Sending again. It can still land until {until}.":
    "Aún no hay acuse de recibo de la red. Se envía de nuevo. Todavía puede registrarse hasta las {until}.",
  "Submitted. Waiting for the next ledger.": "Enviada. Esperando el próximo ledger.",
  "Still waiting. It can land until {until}; it is not failed before then.":
    "Seguimos esperando. Puede registrarse hasta las {until}; no ha fallado antes de esa hora.",
  "The network asked for an unusually high fee ({fee} XLM). Nothing was signed.": "La red pidió una comisión inusualmente alta ({fee} XLM). No se firmó nada.",
  "The fee of the prepared transaction does not match the network's estimate. Nothing was signed.":
    "La comisión de la transacción preparada no coincide con la estimación de la red. No se firmó nada.",
  "Submitted, confirming: waiting for a second RPC endpoint ({host}) to see it.":
    "Enviada, confirmando: esperando a que un segundo punto de acceso RPC ({host}) la vea.",
  "{host} reports it failed.": "{host} la indica como fallida.",
  "{host} does not know it, and its validity window has passed.": "{host} no la conoce y su ventana de validez ya pasó.",
  "{host} did not confirm it in time.": "{host} no la confirmó a tiempo.",
  "Applied according to {host}; no second endpoint could confirm it.": "Aplicada según {host}; ningún segundo punto de acceso pudo confirmarla.",
  "RPC {from} did not answer in time: switched to {to}.": "El RPC {from} no respondió a tiempo: cambio a {to}.",
  "RPC {from} is {n} ledgers behind: switched to {to}.": "El RPC {from} lleva {n} ledgers de retraso: cambio a {to}.",
  "RPC {to} has caught up: switched back to it.": "El RPC {to} vuelve a estar al día: se vuelve a él.",
  "RPC {from} failed: switched to {to}.": "El RPC {from} falló: cambio a {to}.",
};
