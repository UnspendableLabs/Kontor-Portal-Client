import type {
  BLSSigner,
  BLSPoP,
  BLSSignParams,
  HorizonWalletProviderLike,
  HorizonWalletRpcResponse,
  WalletAddress,
  WalletNetwork,
} from "./types";

const VALID_WALLET_NETWORKS: readonly WalletNetwork[] = [
  "mainnet",
  "testnet4",
  "signet",
];

function isWalletNetwork(value: unknown): value is WalletNetwork {
  return (
    typeof value === "string" &&
    (VALID_WALLET_NETWORKS as readonly string[]).includes(value)
  );
}

export class HorizonWalletSigner implements BLSSigner {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  private withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    let id: ReturnType<typeof setTimeout>;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        id = setTimeout(() => reject(new Error(message)), this.timeoutMs);
      }),
    ]).finally(() => clearTimeout(id!));
  }

  private getProvider(): HorizonWalletProviderLike {
    const provider = (
      window as Window & { HorizonWalletProvider?: HorizonWalletProviderLike }
    ).HorizonWalletProvider;
    if (!provider) {
      throw new Error(
        "Horizon Wallet not detected. Please install and unlock the extension.",
      );
    }
    return provider;
  }

  private extractResult<T>(response: HorizonWalletRpcResponse): T {
    if (response.error) {
      const e = response.error;
      const message =
        typeof e === "string"
          ? e
          : (e as { message?: string })?.message ?? JSON.stringify(e);
      throw new Error(message);
    }
    return response.result as T;
  }

  async getAddress(): Promise<WalletAddress> {
    const provider = this.getProvider();
    const response = await this.withTimeout(
      provider.request("getAddresses"),
      "Horizon Wallet did not respond. Try disabling and re-enabling the extension, then refresh the page.",
    );
    const result = this.extractResult<{
      network?: unknown;
      addresses?: { address?: unknown; type?: unknown }[];
    }>(response);

    if (result == null || typeof result !== "object") {
      throw new Error("Wallet did not return address data");
    }

    const taproot = (result.addresses ?? []).find(
      (a) => a?.type === "p2tr" && typeof a?.address === "string" && a.address,
    );
    if (!taproot || typeof taproot.address !== "string" || !taproot.address) {
      throw new Error("Wallet did not return a Taproot (p2tr) address");
    }
    const taprootAddress = taproot.address;

    // Older Horizon Wallet builds (and any custom wallet that hasn't
    // implemented the `network` field yet) return only `{ addresses }`. The
    // bech32m HRP on the Taproot address itself unambiguously identifies
    // mainnet vs testnet/signet, so we can infer the wallet network from
    // the address prefix when the wallet didn't supply one. Mirrors
    // `KontorPortalClient.toWalletNetwork`'s testnet→signet default.
    let network: WalletNetwork;
    if (isWalletNetwork(result.network)) {
      network = result.network;
    } else if (taprootAddress.startsWith("bc1p")) {
      network = "mainnet";
    } else if (taprootAddress.startsWith("tb1p")) {
      network = "signet";
    } else {
      throw new Error("Wallet did not return a valid network");
    }

    return { address: taprootAddress, network };
  }

  async getBLSPoP(address: string): Promise<BLSPoP> {
    const provider = this.getProvider();
    const response = await this.withTimeout(
      provider.request("getBLSPoP", { address }),
      "Horizon Wallet did not respond. Try disabling and re-enabling the extension, then refresh the page.",
    );
    const pop = this.extractResult<BLSPoP>(response);
    if (pop == null || typeof pop !== "object") {
      throw new Error("Wallet did not return Proof of Possession data");
    }
    const { xpubkey, blsPubkey, schnorrSig, blsSig } = pop;
    if (
      typeof xpubkey !== "string"
      || typeof blsPubkey !== "string"
      || typeof schnorrSig !== "string"
      || typeof blsSig !== "string"
      || !xpubkey
      || !blsPubkey
      || !schnorrSig
      || !blsSig
    ) {
      throw new Error("Wallet did not return a valid Proof of Possession");
    }
    return { xpubkey, blsPubkey, schnorrSig, blsSig };
  }

  async signBLS(params: BLSSignParams): Promise<string> {
    const provider = this.getProvider();
    let requestParams: Record<string, string>;
    if (params.messageHex !== undefined) {
      requestParams = { messageHex: params.messageHex, dst: params.dst };
    } else if (params.message !== undefined) {
      requestParams = { message: params.message, dst: params.dst };
    } else {
      throw new Error("BLSSignParams requires either message or messageHex");
    }

    if (params.address !== undefined) {
      requestParams.address = params.address;
    }

    const response = await this.withTimeout(
      provider.request("signMessageBLS", requestParams),
      "Horizon Wallet did not respond. Try disabling and re-enabling the extension, then refresh the page.",
    );

    const result = this.extractResult<{ signature?: string }>(response);
    const signature = result?.signature;
    if (!signature || typeof signature !== "string" || signature.length === 0) {
      throw new Error("Wallet did not return a valid signature");
    }
    return signature;
  }
}
