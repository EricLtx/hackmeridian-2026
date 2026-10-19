// Freighter as a signer for the chain module. The secret key never leaves
// the extension: the page hands it an unsigned transaction and gets back the
// signed envelope.

// The package ships a CommonJS bundle: its default export works under both
// Vite and Node, named imports only under a bundler.
import freighter from "@stellar/freighter-api";
import { WalletError } from "./errors.js";
import { t } from "./i18n.js";

const { WatchWalletChanges, getNetworkDetails, isConnected, requestAccess, signTransaction } = freighter;

const DECLINED = /reject|declin|denied|cancel/i;

function walletMessage(error, fallback) {
  const text = error?.message ?? String(error ?? "");
  return DECLINED.test(text) ? t("You declined the request in your wallet.") : text || fallback;
}

/** Throws unless Freighter is on the network of the deployment. */
async function checkNetwork(passphrase) {
  const details = await getNetworkDetails();
  if (details.error) throw new WalletError(walletMessage(details.error, t("Freighter did not report its network.")));
  if (details.networkPassphrase !== passphrase) {
    const network = details.network || t("another network");
    throw new WalletError(t("Freighter is on {network}. This interface runs on Stellar Testnet only. Switch Freighter to Testnet, then connect again.", { network }));
  }
}

/**
 * Asks Freighter for access and returns a signer. Refuses any network other
 * than the deployment's, both now and at every signature.
 */
export async function connectFreighter(passphrase) {
  const installed = await isConnected();
  if (installed.error || !installed.isConnected) {
    throw new WalletError(t("Freighter was not found in this browser. Install it from freighter.app, then reload this page."));
  }
  const access = await requestAccess();
  if (access.error || !access.address) throw new WalletError(walletMessage(access.error, t("Freighter did not share an address.")));
  await checkNetwork(passphrase);
  const address = access.address;
  return {
    address,
    wallet: "Freighter",
    async sign(txXdr, networkPassphrase) {
      await checkNetwork(networkPassphrase);
      const signed = await signTransaction(txXdr, { networkPassphrase, address });
      if (signed.error) throw new WalletError(walletMessage(signed.error, t("Freighter did not sign.")));
      if (signed.signerAddress && signed.signerAddress !== address) {
        throw new WalletError(t("Freighter signed with another account. Select the connected account in Freighter and try again."));
      }
      return signed.signedTxXdr;
    },
  };
}

/** Calls `onChange({ address, networkPassphrase })` when the user switches account or network. */
export function watchFreighter(onChange) {
  const watcher = new WatchWalletChanges(3000);
  watcher.watch((change) => {
    if (!change?.error) onChange(change);
  });
  return () => watcher.stop();
}
