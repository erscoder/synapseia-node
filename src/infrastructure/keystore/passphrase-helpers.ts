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
 *   2. SYNAPSEIA_WALLET_PASSWORD / WALLET_PASSWORD — back-compat env
 *      vars honoured by the legacy `wallet.json` path. Callers handle
 *      this branch directly because it is shared with the legacy flow.
 *   3. Interactive prompt — `password({ message })` at the call site.
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
