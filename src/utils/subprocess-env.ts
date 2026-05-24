/**
 * Subprocess env sanitization for F-node-008 (P9 family).
 *
 * THREAT MODEL — why this exists
 * ------------------------------
 * The node process historically held wallet passphrases in
 * `process.env` (`SYNAPSEIA_WALLET_PASSWORD`, legacy `WALLET_PASSWORD`).
 * F-node-008 max-security removed every code path that READS those
 * vars — the Tauri wrapper now pipes the typed passphrase over the
 * spawned CLI's stdin instead, and headless deployments use
 * `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE` exclusively. This sanitiser is
 * still essential defence-in-depth: if a CI runner or stale `.env` is
 * misconfigured and exports the deprecated env var anyway, we must NOT
 * let it leak into python / ollama / external subprocesses spawned by
 * the node. Any child process inherits the *full* `process.env` by
 * default, which means:
 *
 *   1. The passphrase becomes readable to anything inside the child
 *      (a poisoned `transformers`/`peft`/`accelerate` wheel can call
 *      `os.environ.get("SYNAPSEIA_WALLET_PASSWORD")` and exfiltrate it).
 *   2. On Linux `/proc/<child-pid>/environ` is readable to the owning
 *      UID — any sibling process at the same UID can dump the env of
 *      the python child even if the node parent enforces stricter
 *      `/proc` controls.
 *
 * The Tauri boot path is considered a TRUSTED source of the env var
 * (the operator's own machine, an in-process spawn the operator
 * controls). The risk is the *child* leaking it onward — so we filter
 * at the spawn boundary, not at the receive boundary.
 *
 * RULE
 * ----
 * EVERY `spawn(...)` / `spawnSync(...)` / `execFile(...)` site that
 * passes a python script, ollama, an external binary, or any process
 * that does not strictly need the passphrase MUST use
 * `sanitizedEnvForSubprocess()` instead of `process.env`. Tests that
 * spawn child processes for the trainer / validator are exempt only
 * when they explicitly set `env: {}` themselves.
 */

/**
 * Env var names that contain wallet / keystore / mnemonic material and
 * MUST NEVER cross a spawn boundary into a child process we do not
 * fully trust. Kept as a closed allowlist of *forbidden* names (not a
 * regex) so a new secret env var is a deliberate addition here, not an
 * accidental allow.
 */
export const SENSITIVE_ENV_VARS: readonly string[] = [
  // Wallet passphrases — historical and current names.
  'WALLET_PASSWORD',
  'SYNAPSEIA_WALLET_PASSWORD',
  // Keystore passphrases.
  'SYNAPSEIA_KEYSTORE_PASSPHRASE',
  // The *file path* to the keystore passphrase is also stripped: the
  // file itself is mode 0600 owned by the operator UID so a python
  // child running at the same UID could still read it. Stripping the
  // hint forces an attacker to enumerate `/run/secrets/` etc.
  'SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE',
  // BIP39 mnemonic — never set by the node itself but a malicious
  // operator harness might leak one through env; defensive strip.
  'SYNAPSEIA_WALLET_MNEMONIC',
  'WALLET_MNEMONIC',
  // Historical opt-in flag — kept in the strip list for defence in
  // depth even though the code path that read it is gone (F-node-008
  // max-security). Leaking the name signals to a worm "this host
  // *used to* accept env passphrases".
  'SYNAPSEIA_ALLOW_INSECURE_ENV_PASSPHRASE',
  // Stdin-passphrase signal — the parent already consumed the
  // passphrase off its own stdin before spawning the child, so this
  // flag would falsely advertise "stdin has a passphrase" to the
  // subprocess. Strip to avoid downstream confusion + supply-chain
  // recon hints.
  'SYNAPSEIA_PASSPHRASE_FROM_STDIN',
  // Legacy wallet override — same reasoning.
  'SYNAPSEIA_ALLOW_LEGACY_WALLET',
  // AWS credentials — defence-in-depth (NIT-3). The node no longer holds AWS
  // creds at all: DiLoCo aggregation S3 I/O is now done over coord-PRESIGNED
  // URLs (`diloco-aggregation-http.ts` — plain HTTP, no SDK, no creds). This
  // strip stays as belt-and-suspenders: should an operator ever set these in
  // the node env, the spawned python aggregation/trainer/validator scripts
  // (which do ZERO S3) must never inherit them, so a poisoned ML wheel inside
  // a child can't exfiltrate them.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

/**
 * Return a shallow clone of `process.env` with every sensitive key
 * removed. Use this as the `env` field of `spawn(...)` /
 * `spawnSync(...)` / `execFile(...)` for any child process that does
 * not specifically need a wallet secret (which is currently NONE of
 * the children the node spawns).
 *
 * `extra` is merged on top — callers typically add thread-cap vars
 * (`OMP_NUM_THREADS=4` etc.) that have no relation to secrets.
 */
export function sanitizedEnvForSubprocess(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SENSITIVE_ENV_VARS) {
    if (k in clone) delete clone[k];
  }
  return { ...clone, ...extra };
}
