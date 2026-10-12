export interface WhitelistRule {
  id: string;
  label: string;              // user-friendly name, e.g. "Uniswap Swap"
  enabled: boolean;
  // Three dimensions — each is optional (null = not checked)
  origin: string | null;      // e.g. "https://app.uniswap.org"
  contractAddress: string | null; // e.g. "0x68b3465..."
  methodSig: string | null;   // 4-byte selector, e.g. "0x5ae401dc"
  // Safety caps (always enforced)
  maxValueEth: string | null;  // max native token value per tx, decimal string
  maxGasLimit: string | null;  // max gas limit per tx, decimal string
  // Metadata
  chainId: number | null;      // null = any chain
  createdAt: number;
  // Epoch ms after which the rule stops auto-signing. null / missing = no
  // expiry (rules created before this field existed keep that behavior).
  expiresAt?: number | null;
}

export interface AutoSignResult {
  allowed: boolean;
  rule?: WhitelistRule;
  reason?: string;
}
