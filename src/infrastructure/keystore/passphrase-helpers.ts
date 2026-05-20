/**
 * Shared helpers for resolving the EncryptedKeystore passphrase from
 * non-interactive channels. Extracted from `cli/index.ts` so that
 * subcommands invoked outside the main boot path (e.g. the staking
 * CLI in `modules/staking/staking-cli.ts`) can apply the exact same
 * F9-hardened resolution rules without duplicating logic.
 *
 * Resolution priority (high → low) at the call site:
 *   1. SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE — file-mounted secret
 *      (Docker secret / systemd LoadCredential / k8s mount). Read by
 *      `readPassphraseFromFile()` below.
 *   2. SYNAPSEIA_PASSPHRASE_FROM_STDIN=true — first line of stdin
 *      (used by the Tauri desktop UI which pipes the typed password to
 *      the spawned CLI; replaces the historical
 *      `SYNAPSEIA_WALLET_PASSWORD` env var which was inheritable to
 *      every child process at the same UID). Read by
 *      `readPassphraseFromStdin()` below.
 *   3. Interactive TTY prompt — `password({ message })` at the call site.
 *
 * NOTE: env-var passphrases (`SYNAPSEIA_WALLET_PASSWORD`,
 * `WALLET_PASSWORD`) are PERMANENTLY DISABLED (F-node-008 max-security
 * mode). Detection of either var triggers a stderr warning in the
 * wallet module; no opt-in path remains.
 */

import { existsSync, statSync } from 'fs';
import { promises as fsp } from 'fs';

export interface PassphraseLogger {
  log: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

/**
 * Read the keystore passphrase from a file-mounted secret. This is the
 * F9-hardened replacement for the old `SYNAPSEIA_KEYSTORE_PASSPHRASE`
 * env var (which a malicious postinstall could grep out of
 * `process.env`). The operator sets `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE`
 * to a path on disk; the file MUST be mode 0600 or stricter and owned
 * by the current UID. Mirrors the Docker secrets / systemd
 * LoadCredential / k8s mounted-secret pattern.
 *
 * Returns the trimmed passphrase on success, or `undefined` if:
 *   - the env var is unset (interactive prompt will run),
 *   - the file is missing / unreadable,
 *   - permission checks fail (we log a warning and fall back to prompt).
 */
export async function readPassphraseFromFile(
  envVal: string | undefined,
  log: PassphraseLogger,
): Promise<string | undefined> {
  if (!envVal || envVal.trim().length === 0) return undefined;
  const filePath = envVal.trim();
  try {
    if (!existsSync(filePath)) {
      log.warn(`[Keystore] SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE points to a non-existent path (${filePath}); falling back to interactive prompt`);
      return undefined;
    }
    if (process.platform !== 'win32') {
      const st = statSync(filePath);
      // World/group must have NO permissions (mode bits 0o077 must be zero).
      if ((st.mode & 0o077) !== 0) {
        log.warn(`[Keystore] passphrase file ${filePath} has insecure mode ${(st.mode & 0o777).toString(8)}; expected 0600 or stricter. Falling back to interactive prompt`);
        return undefined;
      }
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        log.warn(`[Keystore] passphrase file ${filePath} is owned by uid ${st.uid}, not the current user (${process.getuid()}); falling back to interactive prompt`);
        return undefined;
      }
    }
    const raw = await fsp.readFile(filePath, 'utf8');
    const trimmed = raw.replace(/\r?\n$/, '');
    if (trimmed.length === 0) {
      log.warn(`[Keystore] passphrase file ${filePath} is empty; falling back to interactive prompt`);
      return undefined;
    }
    return trimmed;
  } catch (err) {
    log.warn(`[Keystore] could not read passphrase file ${filePath}: ${(err as Error).message}; falling back to interactive prompt`);
    return undefined;
  }
}

/**
 * Read the keystore passphrase from the first line of stdin. Gated by
 * `SYNAPSEIA_PASSPHRASE_FROM_STDIN=true` so a TTY-attached operator
 * never has their interactive shell hijacked by a sibling that wrote
 * to the node's stdin by accident.
 *
 * This is the F-node-008 replacement for the deprecated
 * `SYNAPSEIA_WALLET_PASSWORD` env-var channel: the Tauri desktop UI
 * spawns the node CLI with the flag set, writes `password + "\n"` to
 * the child's stdin, then closes the pipe. The passphrase therefore
 * never crosses any filesystem or env-var boundary — it lives only in
 * the parent's `Zeroizing<String>` and the child's resolved string for
 * the lifetime of the unlock call.
 *
 * Returns the passphrase (without the trailing `\n`) on success, or
 * `undefined` when:
 *   - the env flag is not set to exactly "true",
 *   - stdin is a TTY (operator will be prompted interactively instead),
 *   - stdin EOFs before producing any data (treated as missing input).
 *
 * The function consumes only the first line; anything else on stdin is
 * left in the buffer for the rest of the process to handle.
 */
export async function readPassphraseFromStdin(
  log: PassphraseLogger,
): Promise<string | undefined> {
  if (process.env.SYNAPSEIA_PASSPHRASE_FROM_STDIN !== 'true') return undefined;
  // Defensive: never consume an interactive TTY — the operator types
  // their password at the inquirer prompt downstream.
  if (process.stdin.isTTY) {
    log.warn('[Keystore] SYNAPSEIA_PASSPHRASE_FROM_STDIN=true but stdin is a TTY; ignoring (use interactive prompt)');
    return undefined;
  }
  try {
    return await new Promise<string | undefined>((resolve) => {
      let buf = '';
      let resolved = false;
      const finish = (val: string | undefined) => {
        if (resolved) return;
        resolved = true;
        process.stdin.removeListener('data', onData);
        process.stdin.removeListener('end', onEnd);
        process.stdin.removeListener('error', onError);
        resolve(val);
      };
      const onData = (chunk: Buffer | string) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          finish(line.length === 0 ? undefined : line);
        }
      };
      const onEnd = () => {
        const line = buf.replace(/\r?\n$/, '');
        finish(line.length === 0 ? undefined : line);
      };
      const onError = (err: Error) => {
        log.warn(`[Keystore] failed to read passphrase from stdin: ${err.message}`);
        finish(undefined);
      };
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.on('error', onError);
      // Resume in case stdin was paused (default state when piped).
      if (typeof (process.stdin as NodeJS.ReadStream).resume === 'function') {
        (process.stdin as NodeJS.ReadStream).resume();
      }
    });
  } catch (err) {
    log.warn(`[Keystore] failed to read passphrase from stdin: ${(err as Error).message}; falling back to interactive prompt`);
    return undefined;
  }
}
