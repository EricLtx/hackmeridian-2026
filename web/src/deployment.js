// The deployment file (deployment.testnet.json), fetched next to the page:
// its network, symbols, URLs, addresses and decimals end up in signing
// requests, markup, links and powers of ten, so they are checked before
// anything uses them. A copy of the page that edits only this file cannot
// point it at another network. Pure: no DOM, no network.

import { Networks } from "@stellar/stellar-sdk";
import { MAX_DECIMALS } from "./format.js";
import { t } from "./i18n.js";

const TICKER = /^[A-Za-z0-9]{1,12}$/;
const HTTPS = /^https:\/\/[^\s"'<>]+$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;

/** A whole number of decimals the page can format: 0 to 38. */
export const isDecimals = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_DECIMALS;

/** A plain ticker or currency code, 1 to 12 letters and digits. */
export const isTicker = (value) => typeof value === "string" && TICKER.test(value);

/** `url` when it is an https URL with no space or markup character in it, else null. */
export const httpsUrl = (url) => (typeof url === "string" && HTTPS.test(url) ? url : null);

/**
 * The deployment file, checked: this build runs on the Stellar test network
 * only, whatever the file says; plain tickers, https URLs, contract
 * addresses and decimals from 0 to 38. Throws an Error naming what is wrong.
 */
export function checkDeployment(dep) {
  if (dep?.networkPassphrase !== Networks.TESTNET) throw new Error(t("unexpected network: this interface runs on the Stellar test network only"));
  const symbols = [dep.stablecoin?.code, dep.stablecoin?.currency, dep.fund?.symbol, dep.fund?.navCurrency];
  if (!symbols.every(isTicker)) throw new Error(t("unexpected asset symbol"));
  if (dep.rpcFallbacks !== undefined && !Array.isArray(dep.rpcFallbacks)) throw new Error(t("unexpected URL"));
  if (![dep.rpcUrl, dep.explorer, ...(dep.rpcFallbacks ?? [])].every((u) => httpsUrl(u))) throw new Error(t("unexpected URL"));
  if (!isDecimals(dep.stablecoin.decimals) || !isDecimals(dep.fund.decimals)) throw new Error(t("unexpected decimals"));
  // Every address the page turns into an ScVal: a malformed one would stop each read that uses it.
  const lists = [dep.funds, dep.stablecoins];
  if (lists.some((list) => list !== undefined && !Array.isArray(list))) throw new Error(t("unexpected contract address"));
  const given = (a) => a !== undefined && a !== null;
  const addresses = [
    ...Object.values(dep.contracts ?? {}),
    ...(dep.funds ?? []).flatMap((f) => [f?.shares, ...(given(f?.navFeed) ? [f.navFeed] : [])]),
    ...(dep.stablecoins ?? []).map((c) => c?.contract).filter(given),
  ];
  if (!dep.contracts?.openWindow || !addresses.every((a) => CONTRACT.test(String(a)))) throw new Error(t("unexpected contract address"));
  return dep;
}
