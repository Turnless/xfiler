import { createPublicClient, http, parseAbi, parseEventLogs, formatUnits } from "viem";
import { bsc } from "viem/chains";

const erc20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
]);

export interface ReceiptFill {
  amount: string; // net amount of the received token, human units, > 0
  gasUsed?: string;
  effectiveGasPrice?: string; // wei
}

/**
 * The wallet's NET inflow of `token` in `txHash` (in minus out), read from the receipt.
 * This is what makes the tape a fill price rather than a quote price.
 * Throws (= "receipt decode failed") if the tx reverted, if `spentToken` is given and the wallet
 * sent none of it in the same tx (wrong WALLET_ADDRESS), or if the net inflow is not > 0.
 * Transient RPC errors and a not-yet-indexed receipt are retried until `timeoutMs`.
 */
export async function readFill(
  rpcUrl: string,
  txHash: `0x${string}`,
  token: `0x${string}`,
  wallet: `0x${string}`,
  spentToken: `0x${string}` | null,
  timeoutMs = 60_000,
): Promise<ReceiptFill> {
  const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { retryCount: 3, retryDelay: 500, timeout: 15_000 }) });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: 2_000, retryCount: 6 });
  if (receipt.status !== "success") throw new Error(`tx status ${receipt.status}`);

  const w = wallet.toLowerCase();
  const transfers = parseEventLogs({ abi: erc20, eventName: "Transfer", logs: receipt.logs });
  const of = (t: string) => transfers.filter((l) => l.address.toLowerCase() === t.toLowerCase());
  if (spentToken && !of(spentToken).some((l) => l.args.from.toLowerCase() === w)) {
    throw new Error(`no Transfer of ${spentToken} from ${wallet} in this tx (is WALLET_ADDRESS right?)`);
  }
  let net = 0n;
  for (const l of of(token)) {
    if (l.args.to.toLowerCase() === w) net += l.args.value;
    if (l.args.from.toLowerCase() === w) net -= l.args.value;
  }
  if (net <= 0n) throw new Error(`net inflow of ${token} to ${wallet} is ${net}`);

  const decimals = await client.readContract({ address: token, abi: erc20, functionName: "decimals" });
  return {
    amount: formatUnits(net, decimals),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice?.toString(),
  };
}
