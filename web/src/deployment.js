// The deployment file (deployment.testnet.json), fetched next to the page:
// its network, symbols, URLs, addresses and decimals end up in signing
// requests, markup, links and powers of ten, so they are checked before
// anything uses them. A copy of the page that edits only this file cannot
// point it at another network. Pure: no DOM, no network.

import { Networks, StrKey } from "@stellar/stellar-sdk";
import { MAX_DECIMALS } from "./format.js";
import { locale, t } from "./i18n.js";

const TICKER = /^[A-Za-z0-9]{1,12}$/;
const HTTPS = /^https:\/\/[^\s"'<>]+$/;

/** A contract strkey, its checksum included: a typo that keeps the alphabet would make every read that uses it fail. */
const isContract = (address) => typeof address === "string" && StrKey.isValidContract(address);

/** A whole number of decimals the page can format: 0 to 38. */
export const isDecimals = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_DECIMALS;

/** A plain ticker or currency code, 1 to 12 letters and digits. */
export const isTicker = (value) => typeof value === "string" && TICKER.test(value);

/** `url` when it is an https URL with no space or markup character in it, else null. */
export const httpsUrl = (url) => (typeof url === "string" && HTTPS.test(url) ? url : null);

/** Who runs the RPC hosts the deployment names, by domain: they see the visitor's IP address and the addresses the page reads. */
const PROVIDERS = [
  ["stellar.org", "Stellar Development Foundation"],
  ["gateway.fm", "Gateway.fm"],
];

/**
 * The RPC providers of the deployment, in its order: "Name (host)", or the
 * host alone for a provider this file does not name.
 */
export function rpcProviders(dep) {
  const urls = [dep?.rpcUrl, ...(Array.isArray(dep?.rpcFallbacks) ? dep.rpcFallbacks : [])];
  const hosts = urls.map((url) => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  });
  return [...new Set(hosts.filter(Boolean))].map((host) => {
    const known = PROVIDERS.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
    return known ? `${known[1]} (${host})` : host;
  });
}

/** The providers as one phrase of the interface language: "A and B", "A et B", "A y B". */
export const providersText = (dep) => new Intl.ListFormat(locale(), { style: "long", type: "conjunction" }).format(rpcProviders(dep));

/**
 * The privacy line of a page's footer: who sees the visitor's IP address and
 * the addresses read. `page` is "market" (this page reads the chain) or
 * "history" (it reads only the export; the market page reads the chain).
 */
export function privacyLine(dep, page) {
  const providers = rpcProviders(dep).length ? providersText(dep) : null;
  if (page === "history") {
    return providers
      ? t("Privacy: this page reads no chain data; the market page reads it through {providers}, which see the visitor's IP address and the addresses it reads, a connected wallet's included.", { providers })
      : t("Privacy: this page reads no chain data.");
  }
  return t("Privacy: this page reads the chain through {providers}, which see your IP address and the addresses it reads, your wallet's included.", { providers: providers ?? "—" });
}

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
  // Every address the page turns into an ScVal, checksum included: a malformed one would stop each read that uses it.
  const lists = [dep.funds, dep.stablecoins];
  if (lists.some((list) => list !== undefined && !Array.isArray(list))) throw new Error(t("unexpected contract address"));
  const given = (a) => a !== undefined && a !== null;
  const addresses = [
    ...Object.values(dep.contracts ?? {}),
    ...(dep.funds ?? []).flatMap((f) => [f?.shares, ...(given(f?.navFeed) ? [f.navFeed] : [])]),
    ...(dep.stablecoins ?? []).map((c) => c?.contract).filter(given),
  ];
  if (!dep.contracts?.openWindow || !addresses.every(isContract)) throw new Error(t("unexpected contract address"));
  return dep;
}
