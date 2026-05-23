/**
 * Bootstrap-free dispatcher for one-shot on-chain CLI subcommands.
 *
 * These commands are single Solana transactions implemented with raw
 * `@solana/web3.js` in `modules/staking/staking-cli.ts` and
 * `modules/rewards/rewards-vault-cli.ts`. They do NOT need NestJS DI, the
 * P2P/libp2p layer, or the heartbeat timers — so booting `AppModule`
 * (`NestFactory.createApplicationContext`) before running them is pure
 * overhead. Worse: when a `syn start` node is already running and libp2p is
 * flapping, that heavy init hangs past the node-ui 120s timeout and the
 * on-chain ix never executes.
 *
 * The CLI entry (`cli/index.ts`) short-circuits these subcommands BEFORE
 * `bootstrap()` (same pattern as `chain-info` → `chain-info-lightweight`)
 * and routes them here. This module maps each subcommand to its
 * staking-cli / rewards-vault-cli function, parses args exactly like the
 * legacy commander handlers, and reproduces the SAME stdout markers and
 * exit codes node-ui parses:
 *   - `stake` / `unstake` / `claim-rewards` / `withdraw-*` / `deposit-*`:
 *     node-ui (`StakePanel`/`WalletPanel` → tauri `run_command`) keys off
 *     the process EXIT CODE (`output.status.success()`), so success ⇒
 *     `exit(0)`, failure ⇒ `exit(1)`.
 *   - `claim-wo-rewards`: node-ui `MyNodePanel.tsx` greps stdout for
 *     `__VAULT_CLAIM_OK__ <sig>`. This marker MUST be emitted verbatim.
 *
 * The wallet password arrives via stdin (node-ui sets
 * `SYNAPSEIA_PASSPHRASE_FROM_STDIN=true` and pipes it); `loadWalletWithPassword`
 * → `readPassphraseFromStdin` is bootstrap-free, so this works here.
 */

import logger from '../utils/logger';

/**
 * The subcommands that get the bootstrap-free fast-path. Kept as a `Set`
 * so the CLI entry can do a single O(1) membership check before deciding
 * whether to short-circuit `bootstrap()`.
 */
export const ONE_SHOT_ONCHAIN_COMMANDS = new Set<string>([
  'stake',
  'unstake',
  'claim-rewards',
  'claim-wo-rewards',
  'deposit-sol',
  'deposit-syn',
  'withdraw-sol',
  'withdraw-syn',
]);

/**
 * The staking-cli / rewards-vault-cli surface this dispatcher depends on.
 * Declared as an interface so unit tests inject mocks instead of issuing
 * real Solana transactions (there is no network in tests).
 */
export interface OneShotDeps {
  stakeTokens(amount: number): Promise<string>;
  unstakeTokens(amount: number): Promise<string>;
  claimStakingRewards(): Promise<string>;
  claimWorkOrderRewards(): Promise<string>;
  depositSol(amount: number): Promise<string>;
  depositSyn(amount: number): Promise<string>;
  withdrawSol(amount: number, destination: string): Promise<string>;
  withdrawSyn(amount: number, destination: string): Promise<string>;
}

/**
 * Production dependency loader. Dynamic `import()` keeps the heavy
 * `@solana/web3.js` graph out of the module top-level so the CLI entry can
 * import this file's `ONE_SHOT_ONCHAIN_COMMANDS` Set cheaply.
 */
async function loadDefaultDeps(): Promise<OneShotDeps> {
  const staking = await import('../modules/staking/staking-cli');
  const vault = await import('../modules/rewards/rewards-vault-cli');
  return {
    stakeTokens: staking.stakeTokens,
    unstakeTokens: staking.unstakeTokens,
    claimStakingRewards: staking.claimStakingRewards,
    depositSol: staking.depositSol,
    depositSyn: staking.depositSyn,
    withdrawSol: staking.withdrawSol,
    withdrawSyn: staking.withdrawSyn,
    claimWorkOrderRewards: vault.claimWorkOrderRewards,
  };
}

/** Thrown when arg parsing/validation fails. Maps to exit code 1. */
export class OneShotArgError extends Error {}

/**
 * Parse a positive-amount positional arg the same way the legacy commander
 * handlers did: `parseFloat`, reject NaN or non-positive.
 */
function parsePositiveAmount(raw: string | undefined): number {
  const parsed = parseFloat(String(raw));
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new OneShotArgError('Invalid amount. Please provide a positive number.');
  }
  return parsed;
}

/** Reject an empty/missing required string arg (destination address). */
function requireArg(raw: string | undefined, name: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new OneShotArgError(`Missing required argument: ${name}.`);
  }
  return raw;
}

/**
 * Run a one-shot on-chain subcommand WITHOUT bootstrapping NestJS.
 *
 * `argv` is `process.argv` (or a slice that starts at the node binary):
 * `argv[2]` is the subcommand, `argv[3]`/`argv[4]` the positional args —
 * mirroring how `chain-info-lightweight` reads `process.argv` directly.
 *
 * Reproduces the exact stdout markers / exit codes node-ui expects:
 *   - `claim-wo-rewards` ⇒ `__VAULT_CLAIM_OK__ <sig>` on success.
 *   - all others ⇒ rely on exit code (the staking-cli fns already log their
 *     own `✅ … successful!` lines, which node-ui surfaces as `output`).
 *
 * Throws `OneShotArgError` (bad args → exit 1) or rethrows underlying
 * staking-cli errors. The caller decides exit codes (so it stays testable
 * without `process.exit`).
 */
export async function runOneShotOnchainCommand(
  argv: string[],
  deps?: OneShotDeps,
): Promise<void> {
  const command = argv[2];
  const d = deps ?? (await loadDefaultDeps());

  switch (command) {
    case 'stake': {
      const amount = parsePositiveAmount(argv[3]);
      await d.stakeTokens(amount);
      return;
    }
    case 'unstake': {
      const amount = parsePositiveAmount(argv[3]);
      await d.unstakeTokens(amount);
      return;
    }
    case 'claim-rewards': {
      await d.claimStakingRewards();
      return;
    }
    case 'claim-wo-rewards': {
      const sig = await d.claimWorkOrderRewards();
      // node-ui (MyNodePanel.tsx:159) greps stdout for this exact marker.
      // Keep both lines identical to the legacy commander handler.
      logger.log(`__VAULT_CLAIM_OK__ ${sig}`);
      logger.log(`✅ Rewards claimed. Tx: ${sig}`);
      return;
    }
    case 'deposit-sol': {
      const amount = parsePositiveAmount(argv[3]);
      await d.depositSol(amount);
      return;
    }
    case 'deposit-syn': {
      // Legacy handler: optional amount, info-only (parseFloat or 0).
      const raw = argv[3];
      const amount = raw !== undefined ? parseFloat(raw) : 0;
      await d.depositSyn(Number.isNaN(amount) ? 0 : amount);
      return;
    }
    case 'withdraw-sol': {
      const amount = parsePositiveAmount(argv[3]);
      const destination = requireArg(argv[4], 'destination');
      await d.withdrawSol(amount, destination);
      return;
    }
    case 'withdraw-syn': {
      const amount = parsePositiveAmount(argv[3]);
      const destination = requireArg(argv[4], 'destination');
      await d.withdrawSyn(amount, destination);
      return;
    }
    default:
      throw new OneShotArgError(`Unknown one-shot on-chain command: ${String(command)}`);
  }
}

/**
 * Entry helper for the CLI fast-path: runs the command and translates the
 * outcome into a `process.exit` code (0 success, 1 failure), mirroring the
 * legacy commander handlers' error handling and `chain-info`'s `.catch`.
 * Never returns — always exits.
 */
export async function runOneShotOnchainAndExit(argv: string[]): Promise<never> {
  try {
    await runOneShotOnchainCommand(argv);
    process.exit(0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Command failed: ${msg}`);
    process.exit(1);
  }
}
