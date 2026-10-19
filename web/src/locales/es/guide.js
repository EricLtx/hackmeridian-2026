// Spanish translations of src/guide.js, keyed by the English source text.
export default {
  "I hold fund shares and need cash": "Tengo participaciones de un fondo y necesito liquidez",
  "I lend stablecoins": "Presto stablecoins",
  "I issue a fund": "Emito un fondo",
  "You keep your {sym} shares and their yield. You lock them in the contract and receive {code} in the same transaction, at any hour, for a term you choose.":
    "Usted conserva sus participaciones {sym} y su rendimiento. Las bloquea en el contrato y recibe {code} en la misma transacción, a cualquier hora, por el plazo que elija.",
  "Freighter set to Testnet, with a little XLM for network fees.": "Freighter configurado en Testnet, con algo de XLM para las comisiones de red.",
  "A trustline to {code}, added from the wallet card.": "Una trustline hacia {code}, añadida desde la tarjeta de la billetera.",
  "{sym} shares in your wallet, and your address on the fund issuer's allowlist: the issuer decides who may hold its shares.":
    "Participaciones {sym} en su billetera y su dirección en la lista de autorización del emisor del fondo: el emisor decide quién puede tener sus participaciones.",
  "Pick an offer: the one the issuer designates comes first, then the cheapest.": "Elija una oferta: primero la que designa el emisor, después la más barata.",
  "Choose the shares to lock and the term, from one hour to {term}. The page shows the most you can borrow after the fund's haircut, and what you will owe.":
    "Elija las participaciones que va a bloquear y el plazo, de una hora a {term}. La página muestra lo máximo que puede pedir prestado tras el recorte del fondo y lo que deberá.",
  "Choose the shares to lock and the term, from one hour to {term}. The page shows the most you can borrow after the {rate} haircut, and what you will owe.":
    "Elija las participaciones que va a bloquear y el plazo, de una hora a {term}. La página muestra lo máximo que puede pedir prestado tras el recorte del {rate} y lo que deberá.",
  "Sign once. If the contract would refuse (too large, stale price, paused), the page tells you before you sign.":
    "Firme una sola vez. Si el contrato fuera a rechazar la operación (importe demasiado alto, precio desactualizado, pausa), la página se lo indica antes de firmar.",
  "Repurchase whenever you want: principal plus interest for the started hours, with a minimum of one hour. Your shares come back in the same transaction.":
    "Recompre cuando quiera: el principal más los intereses de las horas iniciadas, con un mínimo de una hora. Sus participaciones vuelven en la misma transacción.",
  "Fixed rate, fixed term, no margin call: nothing is liquidated before the term, whatever the price does.":
    "Tasa fija, plazo fijo, sin llamadas de margen: nada se liquida antes del vencimiento, haga lo que haga el precio.",
  "After the term the lender may take the shares; until it does, you can still repurchase.":
    "Tras el vencimiento, el prestamista puede tomar las participaciones; mientras no lo haga, usted todavía puede recomprar.",
  "A pause of the contract never blocks a repurchase. If the issuer freezes your shares, your debt still settles and the shares are delivered when the issuer allows.":
    "Una pausa del contrato nunca bloquea una recompra. Si el emisor congela sus participaciones, su deuda se liquida igualmente y las participaciones se entregan cuando el emisor lo permite.",
  "Cost: the interest, and the network fee of each transaction (well under 1 XLM). The contract charges no fee of its own.":
    "Coste: los intereses y la comisión de red de cada transacción (muy inferior a 1 XLM). El contrato no cobra ninguna comisión propia.",
  "You deposit {code} in an offer with your rate and longest term. Borrowers draw on it against shares of the funds you list; what is not borrowed stays yours to withdraw at any time.":
    "Usted deposita {code} en una oferta con su tasa y su plazo máximo. Los prestatarios disponen de ella contra participaciones de los fondos que usted indica; lo que no se presta sigue siendo suyo y puede retirarlo en cualquier momento.",
  "An approval by each fund's issuer: you sign an attestation, the issuer approves your address for its fund.":
    "Una aprobación del emisor de cada fondo: usted firma una declaración y el emisor aprueba su dirección para su fondo.",
  "A trustline to {code} and the stablecoins to lend.": "Una trustline hacia {code} y los stablecoins que va a prestar.",
  "On an instance fixed to a single lender, only that address may create offers.": "En una instancia limitada a un único prestamista, solo esa dirección puede crear ofertas.",
  "Create an offer: amount, annual rate, longest term (up to {term}), the funds it accepts (up to eight).":
    "Cree una oferta: importe, tasa anual, plazo máximo (hasta {term}) y los fondos que acepta (hasta ocho).",
  "Each repurchase returns principal and interest to your offer; withdraw any unlent amount whenever you want, even while the contract is paused.":
    "Cada recompra devuelve el principal y los intereses a su oferta; retire cualquier importe no prestado cuando quiera, incluso con el contrato en pausa.",
  "If a borrower has not repurchased by the term, take the shares: they go to your address or to another address the issuer approved.":
    "Si un prestatario no ha recomprado al vencimiento, tome las participaciones: van a su dirección o a otra dirección aprobada por el emisor.",
  "The loan never exceeds the share value after the fund's haircut; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.":
    "El préstamo nunca supera el valor de las participaciones tras el recorte del fondo; el precio procede de la fuente de VL propia del fondo, se contrasta con un corredor y se rechaza si está desactualizado.",
  "The loan never exceeds the share value after the {rate} haircut; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.":
    "El préstamo nunca supera el valor de las participaciones tras el recorte del {rate}; el precio procede de la fuente de VL propia del fondo, se contrasta con un corredor y se rechaza si está desactualizado.",
  "You carry the credit risk inside the haircut and your own reserve; the contract holds no buffer and sells nothing for you.":
    "Usted asume el riesgo de crédito dentro del recorte y de su propia reserva; el contrato no mantiene ningún colchón ni vende nada por usted.",
  "Rate floors, caps and feeds change only through a time delay you can see on this page.":
    "Los mínimos de tasa, los topes y las fuentes de precios solo cambian tras un plazo de espera visible en esta página.",
  "Your fund is admitted as data: its share token, NAV feed, haircut, limits. You never lend against your own fund; you keep the controls an issuer needs.":
    "Su fondo se admite como datos: su token de participación, su fuente de VL, su recorte y sus límites. Usted nunca presta contra su propio fondo; conserva los controles que necesita un emisor.",
  "A SEP-41 share token with an allowlist (a classic Stellar asset with authorization flags works), and a SEP-40 NAV feed published at a known cadence.":
    "Un token de participación SEP-41 con lista de autorización (sirve un activo clásico de Stellar con indicadores de autorización) y una fuente de VL SEP-40 publicada con una cadencia conocida.",
  "A steward key for the fund, and a registered backup key.": "Una clave de gestión del fondo (steward) y una clave de respaldo registrada.",
  "Admit the fund with the governor: two signatures on one call.": "Admita el fondo junto con el gobernador: dos firmas en una misma llamada.",
  "Approve the lenders who may lend against your fund, after their attestation; revoke at will.":
    "Apruebe a los prestamistas que pueden prestar contra su fondo, tras su declaración; revóquelos cuando quiera.",
  "Tune the haircut and the caps inside the risk envelope; lower the NAV reference when the fund distributes; freeze the fund if you must.":
    "Ajuste el recorte y los topes dentro de los límites de riesgo; rebaje la referencia de VL cuando el fondo reparta; congele el fondo si es necesario.",
  "Any loosening of a limit waits {delay}; a tightening applies at once.": "Toda relajación de un límite espera {delay}; un endurecimiento se aplica de inmediato.",
  "If your token refuses a transfer during a repo, the debt still settles and the shares are recorded for later delivery: no exit is ever blocked.":
    "Si su token rechaza una transferencia durante un repo, la deuda se liquida igualmente y las participaciones quedan registradas para una entrega posterior: ninguna salida queda nunca bloqueada.",
  "The contract never lends your fund's shares and never sells them: a defaulted repo hands the shares to an address you approved.":
    "El contrato nunca presta las participaciones de su fondo ni las vende: un repo impagado entrega las participaciones a una dirección que usted aprobó.",
  "Loan currency": "Moneda del préstamo",
  "MiCA-allowlisted stablecoins only; several tokens of one currency share one cap":
    "solo stablecoins autorizados por MiCA; varios tokens de una misma moneda comparten un tope",
  "Funds admitted": "Fondos admitidos",
  "{symbol}: {haircut} haircut plus {fxHaircut} on the exchange rate, {total} in all; NAV in {currency} through an exchange-rate feed, at most {age} old":
    "{symbol}: recorte del {haircut} más {fxHaircut} sobre el tipo de cambio, {total} en total; VL en {currency} mediante una fuente de tipo de cambio, con una antigüedad máxima de {age}",
  "; ": "; ",
  "{symbol}: {haircut} haircut, NAV in {currency} through an exchange-rate feed, NAV at most {age} old":
    "{symbol}: recorte del {haircut}, VL en {currency} mediante una fuente de tipo de cambio, VL con una antigüedad máxima de {age}",
  "{symbol}: {haircut} haircut, NAV in {currency}, NAV at most {age} old": "{symbol}: recorte del {haircut}, VL en {currency}, VL con una antigüedad máxima de {age}",
  "each fund has its own issuer, feed, haircut and caps": "cada fondo tiene su propio emisor, fuente de precios, recorte y topes",
  "Caps": "Topes",
  "{perRepo} per repo, {perFund} per fund ({symbol}), {currencyCap} for the currency": "{perRepo} por repo, {perFund} por fondo ({symbol}), {currencyCap} para la moneda",
  "{perRepo} per repo, {perFund} per fund ({symbol})": "{perRepo} por repo, {perFund} por fondo ({symbol})",
  "exposure grows only through the time delay": "la exposición solo aumenta tras el plazo de espera",
  "Interest": "Intereses",
  "the offer's annual rate, charged per started hour, one hour at least": "la tasa anual de la oferta, cobrada por hora iniciada, con un mínimo de una hora",
  "actual/365; rounded up to the unit in the lender's favor": "real/365; redondeado a la unidad superior a favor del prestamista",
  "Term": "Plazo",
  "one hour to {term}": "de una hora a {term}",
  "early repurchase allowed; after the term the lender may take the shares": "recompra anticipada permitida; tras el vencimiento, el prestamista puede tomar las participaciones",
  "Changes": "Cambios",
  "{delay} time delay on upgrades, feed changes and any loosening": "plazo de espera de {delay} para actualizaciones, cambios de fuente y cualquier relajación",
  "cancellable by the guardian or the sentinel; tightening is immediate": "cancelable por el guardián o el centinela; un endurecimiento es inmediato",
  "Pause": "Pausa",
  "paused: no new offer or repo": "en pausa: ninguna oferta ni repo nuevo",
  "open": "abierto",
  "a pause never blocks repurchase, withdrawal, seizure or delivery": "una pausa nunca bloquea recompras, retiros, ejecuciones ni entregas",
  "Network": "Red",
  "{network}, contract version {version}": "{network}, versión {version} del contrato",
  "no real value; the code is not externally audited yet": "sin valor real; el código aún no ha sido auditado externamente",
};
