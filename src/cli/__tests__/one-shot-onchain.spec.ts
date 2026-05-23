/**
 * Unit tests for the bootstrap-free one-shot on-chain dispatcher
 * (`cli/one-shot-onchain.ts`).
 *
 * The bug: every subcommand except `chain-info` fell into `bootstrap()`
 * (NestFactory.createApplicationContext(AppModule)), spinning up the whole
 * node app (P2P/libp2p + heartbeat) before the on-chain ix could run. That
 * hung past node-ui's 120s timeout. The fix routes the 8 one-shot on-chain
 * ops through this dispatcher BEFORE bootstrap().
 *
 * These tests assert, with the staking-cli / rewards-vault-cli fns mocked
 * (no network in tests):
 *   1. Each subcommand maps to the right fn with correctly-parsed args.
 *   2. Arg validation matches the legacy commander handlers (NaN / <= 0
 *      rejected for amount; missing destination rejected).
 *   3. Unknown commands are rejected.
 *   4. The `__VAULT_CLAIM_OK__ <sig>` stdout marker node-ui greps for is
 *      still emitted by `claim-wo-rewards`.
 *   5. The membership Set covers exactly the 8 fast-path commands.
 */

import {
  ONE_SHOT_ONCHAIN_COMMANDS,
  OneShotArgError,
  runOneShotOnchainCommand,
  type OneShotDeps,
} from '../one-shot-onchain';
import logger from '../../utils/logger';

// `process.argv` shape is [node, script, command, ...args]. Tests build that
// prefix so arg indices (argv[3], argv[4]) match production exactly.
function argv(...rest: string[]): string[] {
  return ['node', 'cli.js', ...rest];
}

function makeDeps(): jest.Mocked<OneShotDeps> {
  return {
    stakeTokens: jest.fn().mockResolvedValue('sig-stake'),
    unstakeTokens: jest.fn().mockResolvedValue('sig-unstake'),
    claimStakingRewards: jest.fn().mockResolvedValue('sig-claim'),
    claimWorkOrderRewards: jest.fn().mockResolvedValue('sig-vault'),
    depositSol: jest.fn().mockResolvedValue('sig-deposit-sol'),
    depositSyn: jest.fn().mockResolvedValue(''),
    withdrawSol: jest.fn().mockResolvedValue('sig-withdraw-sol'),
    withdrawSyn: jest.fn().mockResolvedValue('sig-withdraw-syn'),
  };
}

describe('ONE_SHOT_ONCHAIN_COMMANDS', () => {
  it('contains exactly the 8 fast-path on-chain commands', () => {
    expect([...ONE_SHOT_ONCHAIN_COMMANDS].sort()).toEqual(
      [
        'claim-rewards',
        'claim-wo-rewards',
        'deposit-sol',
        'deposit-syn',
        'stake',
        'unstake',
        'withdraw-sol',
        'withdraw-syn',
      ].sort(),
    );
  });

  it('does NOT include commands that must keep bootstrapping', () => {
    for (const cmd of ['start', 'wallet-create', 'wallet-verify', 'config', 'chain-info', 'stake-info']) {
      expect(ONE_SHOT_ONCHAIN_COMMANDS.has(cmd)).toBe(false);
    }
  });
});

describe('runOneShotOnchainCommand — dispatch + arg parsing', () => {
  let deps: jest.Mocked<OneShotDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('stake → stakeTokens(parsedAmount)', async () => {
    await runOneShotOnchainCommand(argv('stake', '12.5'), deps);
    expect(deps.stakeTokens).toHaveBeenCalledWith(12.5);
    expect(deps.stakeTokens).toHaveBeenCalledTimes(1);
  });

  it('unstake → unstakeTokens(parsedAmount)', async () => {
    await runOneShotOnchainCommand(argv('unstake', '3'), deps);
    expect(deps.unstakeTokens).toHaveBeenCalledWith(3);
  });

  it('claim-rewards → claimStakingRewards() with no args', async () => {
    await runOneShotOnchainCommand(argv('claim-rewards'), deps);
    expect(deps.claimStakingRewards).toHaveBeenCalledWith();
  });

  it('deposit-sol → depositSol(parsedAmount)', async () => {
    await runOneShotOnchainCommand(argv('deposit-sol', '1'), deps);
    expect(deps.depositSol).toHaveBeenCalledWith(1);
  });

  it('deposit-syn → depositSyn(parsedAmount) when amount provided', async () => {
    await runOneShotOnchainCommand(argv('deposit-syn', '7'), deps);
    expect(deps.depositSyn).toHaveBeenCalledWith(7);
  });

  it('deposit-syn → depositSyn(0) when amount omitted (optional, info-only)', async () => {
    await runOneShotOnchainCommand(argv('deposit-syn'), deps);
    expect(deps.depositSyn).toHaveBeenCalledWith(0);
  });

  it('deposit-syn → depositSyn(0) when amount is non-numeric (no throw, matches legacy)', async () => {
    await runOneShotOnchainCommand(argv('deposit-syn', 'notanumber'), deps);
    expect(deps.depositSyn).toHaveBeenCalledWith(0);
  });

  it('withdraw-sol → withdrawSol(parsedAmount, destination)', async () => {
    await runOneShotOnchainCommand(argv('withdraw-sol', '0.5', 'DestPubkey111'), deps);
    expect(deps.withdrawSol).toHaveBeenCalledWith(0.5, 'DestPubkey111');
  });

  it('withdraw-syn → withdrawSyn(parsedAmount, destination)', async () => {
    await runOneShotOnchainCommand(argv('withdraw-syn', '42', 'DestPubkey222'), deps);
    expect(deps.withdrawSyn).toHaveBeenCalledWith(42, 'DestPubkey222');
  });
});

describe('runOneShotOnchainCommand — arg validation (matches commander handlers)', () => {
  let deps: jest.Mocked<OneShotDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it.each(['stake', 'unstake', 'deposit-sol', 'withdraw-sol', 'withdraw-syn'])(
    '%s rejects a non-numeric amount (NaN)',
    async (cmd) => {
      await expect(runOneShotOnchainCommand(argv(cmd, 'abc', 'Dest'), deps)).rejects.toBeInstanceOf(
        OneShotArgError,
      );
    },
  );

  it.each(['stake', 'unstake', 'deposit-sol', 'withdraw-sol', 'withdraw-syn'])(
    '%s rejects a zero amount',
    async (cmd) => {
      await expect(runOneShotOnchainCommand(argv(cmd, '0', 'Dest'), deps)).rejects.toBeInstanceOf(
        OneShotArgError,
      );
    },
  );

  it.each(['stake', 'unstake', 'deposit-sol', 'withdraw-sol', 'withdraw-syn'])(
    '%s rejects a negative amount',
    async (cmd) => {
      await expect(runOneShotOnchainCommand(argv(cmd, '-5', 'Dest'), deps)).rejects.toBeInstanceOf(
        OneShotArgError,
      );
    },
  );

  it('amount rejection happens BEFORE the on-chain fn is called', async () => {
    await expect(runOneShotOnchainCommand(argv('stake', '0'), deps)).rejects.toBeInstanceOf(
      OneShotArgError,
    );
    expect(deps.stakeTokens).not.toHaveBeenCalled();
  });

  it('withdraw-sol rejects a missing destination', async () => {
    await expect(runOneShotOnchainCommand(argv('withdraw-sol', '1'), deps)).rejects.toBeInstanceOf(
      OneShotArgError,
    );
    expect(deps.withdrawSol).not.toHaveBeenCalled();
  });

  it('withdraw-syn rejects an empty destination', async () => {
    await expect(
      runOneShotOnchainCommand(argv('withdraw-syn', '1', '   '), deps),
    ).rejects.toBeInstanceOf(OneShotArgError);
    expect(deps.withdrawSyn).not.toHaveBeenCalled();
  });

  it('rejects an unknown command', async () => {
    await expect(runOneShotOnchainCommand(argv('totally-unknown'), deps)).rejects.toBeInstanceOf(
      OneShotArgError,
    );
  });
});

describe('runOneShotOnchainCommand — stdout markers node-ui parses', () => {
  let deps: jest.Mocked<OneShotDeps>;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    deps = makeDeps();
    logSpy = jest.spyOn(logger, 'log').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('claim-wo-rewards emits `__VAULT_CLAIM_OK__ <sig>` verbatim (MyNodePanel.tsx greps it)', async () => {
    deps.claimWorkOrderRewards.mockResolvedValue('TXSIG_VAULT_123');
    await runOneShotOnchainCommand(argv('claim-wo-rewards'), deps);

    const logged = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain('__VAULT_CLAIM_OK__ TXSIG_VAULT_123');
    // The marker must be greppable by node-ui's /__VAULT_CLAIM_OK__\s+(\S+)/.
    const match = logged.join('\n').match(/__VAULT_CLAIM_OK__\s+(\S+)/);
    expect(match?.[1]).toBe('TXSIG_VAULT_123');
  });

  it('stake/unstake/claim-rewards/withdraw/deposit do NOT emit the vault marker (exit-code only)', async () => {
    await runOneShotOnchainCommand(argv('stake', '1'), deps);
    await runOneShotOnchainCommand(argv('claim-rewards'), deps);
    await runOneShotOnchainCommand(argv('withdraw-sol', '1', 'Dest'), deps);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('__VAULT_CLAIM_OK__');
  });
});

describe('runOneShotOnchainCommand — error propagation', () => {
  it('rethrows an underlying staking-cli error (caller maps to exit 1)', async () => {
    const deps = makeDeps();
    deps.stakeTokens.mockRejectedValue(new Error('boom: insufficient SYN'));
    await expect(runOneShotOnchainCommand(argv('stake', '1'), deps)).rejects.toThrow(
      'boom: insufficient SYN',
    );
  });
});
