// Spanish translations of src/errors.js, keyed by the English source text.
export default {
  "This function is not available in this contract version.": "Esta función no está disponible en esta versión del contrato.",
  "These fund shares are not accepted as collateral.": "Estas participaciones del fondo no se aceptan como garantía.",
  "The haircut setting of this fund is invalid.": "El ajuste de recorte de este fondo no es válido.",
  "Amounts must be greater than zero.": "Los importes deben ser mayores que cero.",
  "The term is outside what is allowed.": "El plazo está fuera de lo permitido.",
  "Choose {term}.": "Elija un plazo de {term}.",
  "The minimum is 1 hour.": "El mínimo es de una hora.",
  "The price feed has no price for this fund right now.": "La fuente de precios no tiene precio para este fondo en este momento.",
  "The contract is not configured.": "El contrato no está configurado.",
  "New loans and new offers are paused. Repurchases and withdrawals still work.":
    "Los nuevos préstamos y las nuevas ofertas están en pausa. Las recompras y los retiros siguen funcionando.",
  "This stablecoin is not accepted by the contract.": "El contrato no acepta este stablecoin.",
  "The fund and the stablecoin are in different currencies.": "El fondo y el stablecoin están en monedas distintas.",
  "The fund price or the exchange rate is too old to lend against. It works again after the next publication.":
    "El precio del fondo o el tipo de cambio es demasiado antiguo para prestar sobre él. Vuelve a funcionar tras la próxima publicación.",
  "The latest price is outside its plausible range, so the contract refuses to lend against it.":
    "El último precio está fuera de su rango plausible, así que el contrato se niega a prestar sobre él.",
  "This is more than the shares can secure.": "Es más de lo que las participaciones pueden garantizar.",
  "The maximum is {max}.": "El máximo es {max}.",
  "This offer does not exist.": "Esta oferta no existe.",
  "The offer does not hold enough for this amount.": "La oferta no tiene suficiente para este importe.",
  "It holds {available}.": "Tiene {available}.",
  "This position does not exist.": "Esta posición no existe.",
  "This position is already closed.": "Esta posición ya está cerrada.",
  "This position has not reached its term yet.": "Esta posición aún no ha llegado a su vencimiento.",
  "You can take the shares from {when}.": "Podrá tomar las participaciones a partir de {when}.",
  "This loan would go over a limit: per loan, per fund or for the whole currency. Try a smaller amount.":
    "Este préstamo superaría un límite: por préstamo, por fondo o para toda la moneda. Pruebe con un importe menor.",
  "An offer must list between one and eight different funds.": "Una oferta debe incluir entre uno y ocho fondos distintos.",
  "Seized shares can only go to a lender the fund issuer approves, and your address is not approved for this fund any more. Ask the issuer to approve it again, then retry.":
    "Las participaciones ejecutadas solo pueden ir a un prestamista que apruebe el emisor del fondo, y su dirección ya no está aprobada para este fondo. Pida al emisor que la apruebe de nuevo y vuelva a intentarlo.",
  "Your address is not an approved lender for this fund. The fund issuer approves lenders.":
    "Su dirección no corresponde a un prestamista aprobado para este fondo. El emisor del fondo aprueba a los prestamistas.",
  "The lender of this offer is no longer approved by the fund issuer. Pick another offer.":
    "El prestamista de esta oferta ya no está aprobado por el emisor del fondo. Elija otra oferta.",
  "A token transfer did not move the exact amount expected.": "Una transferencia de token no movió exactamente el importe esperado.",
  "This offer does not accept these fund shares.": "Esta oferta no acepta estas participaciones del fondo.",
  "The rate must be between 0 % and 100 % a year.": "La tasa debe estar entre el 0 % y el 100 % anual.",
  "These amounts are too large to compute.": "Estos importes son demasiado grandes para calcularlos.",
  "A setting lies outside the protocol risk limits.": "Un ajuste queda fuera de los límites de riesgo del protocolo.",
  "The fund issuer has suspended new loans on this fund.": "El emisor del fondo ha suspendido los nuevos préstamos sobre este fondo.",
  "The price feed returned an invalid price.": "La fuente de precios devolvió un precio no válido.",
  "The fund is listed twice in the offer.": "El fondo figura dos veces en la oferta.",
  "This wallet does not hold the role this action needs.": "Esta billetera no tiene el rol que requiere esta acción.",
  "The fund's two price feeds disagree, so no loan is priced until they agree again.":
    "Las dos fuentes de precios del fondo no coinciden, así que no se valora ningún préstamo hasta que vuelvan a coincidir.",
  "The fund issuer still refuses the transfer of these shares. They stay reserved for you; retry once the issuer lifts its block.":
    "El emisor del fondo sigue rechazando la transferencia de estas participaciones. Siguen reservadas para usted; vuelva a intentarlo cuando el emisor levante el bloqueo.",
  "No shares are waiting for release on this repo.": "No hay participaciones pendientes de liberar en este repo.",
  "This change is waiting for its time delay to pass.": "Este cambio espera a que transcurra su plazo de espera.",
  "This instance is run by a single lender: only that lender can make offers here.":
    "Esta instancia la opera un único prestamista: solo ese prestamista puede publicar ofertas aquí.",
  "The fund's issuer cannot lend against its own fund.": "El emisor del fondo no puede prestar contra su propio fondo.",
  "The issuer must record this lender's declaration before approving it.":
    "El emisor debe registrar la declaración de este prestamista antes de aprobarlo.",
  "The exchange-rate band of this fund would be wider than its exchange-rate haircut, which the contract refuses.":
    "La banda del tipo de cambio de este fondo sería más amplia que su recorte por tipo de cambio, algo que el contrato rechaza.",
  "The sentinel must be a key that holds no other role.": "El centinela debe ser una clave que no tenga ningún otro rol.",
  "The contract's stored records are already at the current version.": "Los registros almacenados del contrato ya están en la versión actual.",
  "The contract was just upgraded and its stored records are not migrated yet: new loans and offers resume once the governor migrates them. Repurchases, withdrawals and deliveries still work.":
    "El contrato acaba de actualizarse y sus registros aún no se han migrado: los nuevos préstamos y ofertas se reanudan en cuanto el gobernador los migre. Las recompras, los retiros y las entregas siguen funcionando.",
  "This wallet is not on the fund's allowlist.": "Esta billetera no está en la lista de autorización del fondo.",
  "Ask the operator to run: {command}": "Pida al operador que ejecute: {command}",
  "Ask the operator to onboard it.": "Pida al operador que la registre.",
  "The fund issuer has frozen the shares of this wallet.": "El emisor del fondo ha congelado las participaciones de esta billetera.",
  "You hold fewer fund shares than this.": "Tiene menos participaciones del fondo que esa cantidad.",
  "This account does not exist on testnet yet. Fund it with test XLM first.":
    "Esta cuenta aún no existe en testnet. Primero, fondéela con XLM de prueba.",
  "Your {code} balance is too low for this.": "Su saldo de {code} es demasiado bajo para esta operación.",
  "Your {code} trustline is not authorized by the issuer.": "Su trustline de {code} no está autorizada por el emisor.",
  "This wallet has no {code} trustline. Use \"Add {code}\" first.": "Esta billetera no tiene trustline de {code}. Use primero “Añadir {code}”.",
  "The price feed refused the operation.": "La fuente de precios rechazó la operación.",
  "A contract refused the operation.": "Un contrato rechazó la operación.",
  "A token contract refused the operation.": "Un contrato de token rechazó la operación.",
  "The transaction expired before it landed. Nothing changed on chain. You can try again.":
    "La transacción caducó antes de registrarse. Nada cambió en la cadena. Puede volver a intentarlo.",
  "The network refused the transaction. Nothing changed on chain.": "La red rechazó la transacción. Nada cambió en la cadena.",
  "The transaction failed on chain. Nothing changed.": "La transacción falló en la cadena. Nada cambió.",
  "The network did not answer. Check your connection and try again.": "La red no respondió. Compruebe su conexión y vuelva a intentarlo.",
  "The RPC endpoint refused the request as one too many. Try again in a moment.": "El punto de acceso RPC rechazó la solicitud por exceso de solicitudes. Vuelva a intentarlo en un momento.",
  "Something went wrong.": "Algo salió mal.",
  "The transaction was sent and one RPC endpoint reports it confirmed, but a second endpoint did not confirm it. Check it on the explorer before relying on it or trying again.":
    "La transacción se envió y un punto de acceso RPC la da por confirmada, pero un segundo punto de acceso no la confirmó. Compruébela en el explorador antes de fiarse de ella o de volver a intentarlo.",
};
