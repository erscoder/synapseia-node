/**
 * Bootstrap-free `chain-info` implementation.
 *
 * The desktop UI polls every 15s for wallet balances. Going through
 * `NestFactory.createApplicationContext(AppModule)` forces the P2P layer,
 * heartbeat timers and model subscriber to start up as side effects —
 * which connect to the coordinator, hammer libp2p, and leak back into the
 * coordinator's log stream. This helper avoids all of that by:
 *   1. Reading the wallet public key directly from `wallet.json` (plaintext
 *      field, no decryption, no password).
 *   2. Querying Solana directly with `@solana/web3.js`.
 *   3. Querying the coordinator's HTTP stake endpoint (optional).
 *
 * It emits a single sentinel line the Rust side parses:
 *   __CHAIN_INFO__ {"wallet":"…","sol":0.0,"syn":0.0,"staked":0.0,"tokenAccountExists":false}
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getCoordinatorUrl } from '../constants/coordinator';

interface ChainInfoPayload {
  wallet: string | null;
  sol: number;
  syn: number;
  // staking: read DIRECT from the on-chain StakeAccount, not the coordinator.
  staked: number;
  rewardsPending: number;
  stakeAccountExists: boolean;
  stakeLockedUntil: number;
  tokenAccountExists: boolean;
  coordinatorReachable: boolean;
  // rewards vault (work-order rewards): read DIRECT from the RewardAccount
  // PDA in syn_rewards_vault, same program the dashboard's Claim button
  // targets. byType breakdown comes from the coordinator (no on-chain shape
  // for per-type splits).
  vaultClaimableSyn: number;
  rewardsByType: Record<string, number>;
  // Node-level stats from coordinator's persistent `nodes` table.
  presencePoints: number;
  totalWins: number;
  totalSubmissions: number;
  unclaimedSyn: number;
  totalClaimedSyn: number;
  canaryStrikes: number;
  anomalyWarnings: number;
  attestationFailures: number;
  tier: number | null;
  nodeName: string | null;
}

function walletDir(): string {
  return process.env.SYNAPSEIA_HOME ?? join(homedir(), '.synapseia');
}

function readPublicKey(): string | null {
  const walletPath = join(walletDir(), 'wallet.json');
  if (!existsSync(walletPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(walletPath, 'utf-8'));
    if (typeof raw.publicKey === 'string' && raw.publicKey.length >= 32) {
      return raw.publicKey;
    }
    return null;
  } catch {
    return null;
  }
}

function readCoordinatorUrl(): string {
  // Coordinator URL is env-var-only with a hardcoded official fallback.
  // Any legacy `coordinatorUrl` field in config.json is ignored.
  return getCoordinatorUrl();
}

async function fetchSolBalance(rpcUrl: string, pubkey: string): Promise<number> {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const conn = new Connection(rpcUrl, 'confirmed');
  try {
    const lamports = await conn.getBalance(new PublicKey(pubkey));
    return lamports / 1_000_000_000;
  } catch {
    return 0;
  }
}

async function fetchSynBalance(
  rpcUrl: string,
  pubkey: string,
  mint: string,
): Promise<{ amount: number; accountExists: boolean }> {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const conn = new Connection(rpcUrl, 'confirmed');
  try {
    const accounts = await conn.getTokenAccountsByOwner(new PublicKey(pubkey), {
      mint: new PublicKey(mint),
    });
    if (accounts.value.length === 0) {
      return { amount: 0, accountExists: false };
    }
    let total = 0n;
    for (const acc of accounts.value) {
      const info = await conn.getTokenAccountBalance(acc.pubkey);
      total += BigInt(info.value.amount);
    }
    return { amount: Number(total) / 1_000_000_000, accountExists: true };
  } catch {
    return { amount: 0, accountExists: false };
  }
}

interface StakeInfo {
  exists: boolean;
  amount: number;
  rewardsPending: number;
  lockedUntil: number;
}

/**
 * Read the on-chain StakeAccount directly. No coordinator round-trip, no
 * NestJS DI. Mirrors packages/node/src/modules/staking/staking-cli.ts
 * (findStakeAccount + getStakeInfo) but bootstrap-free.
 *
 * The StakeAccount layout (after the 8-byte Anchor discriminator):
 *   [8-39]    owner            Pubkey(32)
 *   [40-71]   coord_authority  Pubkey(32)
 *   [72-79]   amount           u64   ← staked lamports
 *   [80]      tier             u8
 *   [81-88]   lm               u64
 *   [89]      ban_times        u8
 *   [90-97]   banned_until     i64
 *   [98-161]  ban_reason       bytes[64]
 *   [162-169] locked_until     i64
 *   [170-177] rewards_pending  u64   ← claimable rewards
 */
async function fetchStakeInfo(
  rpcUrl: string,
  ownerPubkey: string,
  stakingProgramId: string,
): Promise<StakeInfo> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const conn = new Connection(rpcUrl, 'confirmed');
    const owner = new PublicKey(ownerPubkey);

    const accounts = await conn.getProgramAccounts(new PublicKey(stakingProgramId), {
      filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
    });
    if (accounts.length === 0) {
      return { exists: false, amount: 0, rewardsPending: 0, lockedUntil: 0 };
    }

    const data = accounts[0].account.data;
    if (data.length < 178) {
      return { exists: false, amount: 0, rewardsPending: 0, lockedUntil: 0 };
    }

    const amount = Number(data.readBigUInt64LE(72)) / 1_000_000_000;
    const lockedUntil = Number(data.readBigInt64LE(162));
    const rewardsPending = Number(data.readBigUInt64LE(170)) / 1_000_000_000;
    return { exists: true, amount, rewardsPending, lockedUntil };
  } catch {
    return { exists: false, amount: 0, rewardsPending: 0, lockedUntil: 0 };
  }
}

async function fetchCoordinatorReachable(coordinatorUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${coordinatorUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read the `syn_rewards_vault` RewardAccount PDA and return the claimable
 * SYN (UI units, not lamports). Zero when the PDA doesn't exist yet.
 *
 * Layout after the 8-byte Anchor discriminator:
 *   [8..40]   owner         Pubkey(32)
 *   [40..48]  unclaimed     u64 LE  ← what we read
 */
async function fetchVaultClaimable(
  rpcUrl: string,
  ownerPubkey: string,
  vaultProgramId: string,
): Promise<number> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const conn = new Connection(rpcUrl, 'confirmed');
    const owner = new PublicKey(ownerPubkey);
    const program = new PublicKey(vaultProgramId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reward_account'), owner.toBuffer()],
      program,
    );
    const info = await conn.getAccountInfo(pda, 'confirmed');
    if (!info || info.data.length < 8 + 32 + 8) return 0;
    const lamports = info.data.readBigUInt64LE(8 + 32);
    return Number(lamports) / 1_000_000_000;
  } catch {
    return 0;
  }
}

interface RewardsBreakdown {
  byType: Record<string, number>;
  totalClaimedSyn: number;
}

/**
 * GET /rewards/claimable/:wallet from the coordinator. Returns the
 * per-type breakdown (training/research/DiLoCo/…) and lifetime claimed
 * amount. Coordinator unreachable → empty result.
 */
async function fetchRewardsBreakdown(
  coordinatorUrl: string,
  pubkey: string,
): Promise<RewardsBreakdown> {
  try {
    const res = await fetch(
      `${coordinatorUrl}/rewards/claimable/${encodeURIComponent(pubkey)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return { byType: {}, totalClaimedSyn: 0 };
    const data = (await res.json()) as {
      totalClaimedSyn?: string | number;
      byType?: Record<string, string | number>;
    };
    const byType: Record<string, number> = {};
    for (const [k, v] of Object.entries(data.byType ?? {})) {
      const n = typeof v === 'string' ? parseFloat(v) : v;
      if (Number.isFinite(n)) byType[k] = n as number;
    }
    const totalClaimedSyn =
      typeof data.totalClaimedSyn === 'string'
        ? parseFloat(data.totalClaimedSyn)
        : typeof data.totalClaimedSyn === 'number'
          ? data.totalClaimedSyn
          : 0;
    return { byType, totalClaimedSyn: Number.isFinite(totalClaimedSyn) ? totalClaimedSyn : 0 };
  } catch {
    return { byType: {}, totalClaimedSyn: 0 };
  }
}

interface NodeStats {
  presencePoints: number;
  totalWins: number;
  totalSubmissions: number;
  unclaimedSyn: number;
  totalClaimedSyn: number;
  canaryStrikes: number;
  anomalyWarnings: number;
  attestationFailures: number;
  tier: number | null;
  name: string | null;
}

const EMPTY_STATS: NodeStats = {
  presencePoints: 0,
  totalWins: 0,
  totalSubmissions: 0,
  unclaimedSyn: 0,
  totalClaimedSyn: 0,
  canaryStrikes: 0,
  anomalyWarnings: 0,
  attestationFailures: 0,
  tier: null,
  name: null,
};

async function fetchNodeStats(coordinatorUrl: string, pubkey: string): Promise<NodeStats> {
  try {
    const res = await fetch(
      `${coordinatorUrl}/node/${encodeURIComponent(pubkey)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return EMPTY_STATS;
    const data = (await res.json()) as Record<string, unknown>;
    const toNumber = (v: unknown): number => {
      const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0;
      return Number.isFinite(n) ? n : 0;
    };
    const tierRaw = data.tier;
    const tierNum =
      typeof tierRaw === 'string' ? parseInt(tierRaw, 10) : typeof tierRaw === 'number' ? tierRaw : NaN;
    return {
      presencePoints: toNumber(data.presencePoints),
      totalWins: toNumber(data.totalWins),
      totalSubmissions: toNumber(data.totalSubmissions),
      unclaimedSyn: toNumber(data.unclaimedSyn),
      totalClaimedSyn: toNumber(data.totalClaimedSyn),
      canaryStrikes: toNumber(data.canaryStrikes),
      anomalyWarnings: toNumber(data.anomalyWarnings),
      attestationFailures: toNumber(data.attestationFailures),
      tier: Number.isFinite(tierNum) ? (tierNum as number) : null,
      name: typeof data.name === 'string' ? data.name : null,
    };
  } catch {
    return EMPTY_STATS;
  }
}

export async function runChainInfoLightweight(): Promise<void> {
  const wallet = readPublicKey();
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const synMint =
    process.env.SYN_TOKEN_MINT ?? 'DCdWHhoeEwHJ3Fy3DRTk4yvZPXq3mSNZKtbPJzUfpUh8';
  const stakingProgramId =
    process.env.STAKING_PROGRAM_ID ?? 'CYW5Cprp5JuzaXtPyV8LPBgPzbze6QHnc3oFBAVaFkfw';
  const rewardsVaultProgramId =
    process.env.REWARDS_VAULT_PROGRAM_ID ?? 'D9pkzWv2Ak9J8vXDVcMM1P51hDmjRJEwbuYHxCuJKTEN';

  const emptyPayload: ChainInfoPayload = {
    wallet,
    sol: 0,
    syn: 0,
    staked: 0,
    rewardsPending: 0,
    stakeAccountExists: false,
    stakeLockedUntil: 0,
    tokenAccountExists: false,
    coordinatorReachable: false,
    vaultClaimableSyn: 0,
    rewardsByType: {},
    presencePoints: 0,
    totalWins: 0,
    totalSubmissions: 0,
    unclaimedSyn: 0,
    totalClaimedSyn: 0,
    canaryStrikes: 0,
    anomalyWarnings: 0,
    attestationFailures: 0,
    tier: null,
    nodeName: null,
  };

  if (!wallet) {
    process.stdout.write(`__CHAIN_INFO__ ${JSON.stringify(emptyPayload)}\n`);
    process.exit(0);
  }

  const coordinatorUrl = readCoordinatorUrl();

  const [solBalance, syn, stake, stats, coordReachable, vaultClaimable, breakdown] =
    await Promise.all([
      fetchSolBalance(rpcUrl, wallet),
      fetchSynBalance(rpcUrl, wallet, synMint),
      fetchStakeInfo(rpcUrl, wallet, stakingProgramId),
      fetchNodeStats(coordinatorUrl, wallet),
      fetchCoordinatorReachable(coordinatorUrl),
      fetchVaultClaimable(rpcUrl, wallet, rewardsVaultProgramId),
      fetchRewardsBreakdown(coordinatorUrl, wallet),
    ]);

  const payload: ChainInfoPayload = {
    ...emptyPayload,
    sol: solBalance,
    syn: syn.amount,
    tokenAccountExists: syn.accountExists,
    staked: stake.amount,
    rewardsPending: stake.rewardsPending,
    stakeAccountExists: stake.exists,
    stakeLockedUntil: stake.lockedUntil,
    coordinatorReachable: coordReachable,
    vaultClaimableSyn: vaultClaimable,
    rewardsByType: breakdown.byType,
    presencePoints: stats.presencePoints,
    totalWins: stats.totalWins,
    totalSubmissions: stats.totalSubmissions,
    unclaimedSyn: stats.unclaimedSyn,
    // Prefer the /rewards/claimable endpoint's totalClaimedSyn over the one
    // from /node/:wallet when available — it's the authoritative count.
    totalClaimedSyn: breakdown.totalClaimedSyn || stats.totalClaimedSyn,
    canaryStrikes: stats.canaryStrikes,
    anomalyWarnings: stats.anomalyWarnings,
    attestationFailures: stats.attestationFailures,
    tier: stats.tier,
    nodeName: stats.name,
  };

  process.stdout.write(`__CHAIN_INFO__ ${JSON.stringify(payload)}\n`);
  process.exit(0);
}
