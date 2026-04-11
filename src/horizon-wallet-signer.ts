import type {
  BLSSigner,
  BLSPoP,
  BLSSignParams,
  HorizonWalletProviderLike,
  HorizonWalletRpcResponse,
} from "./types";

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
