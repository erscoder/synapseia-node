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
 * Env var names that can REDIRECT an npm registry/proxy lookup. The
 * self-update path (self-updater.ts) hard-pins `registry.npmjs.org` on
 * every npm invocation. The trust this provides is SPECIFIC and bounded:
 * by forcing every install/view/audit to talk to the real npmjs.org, the
 * pin guarantees that the registry signature + sigstore provenance that
 * `npm audit signatures` checks, and the `dist.integrity` that the
 * post-install hash cross-check fetches, are the ones npmjs.org actually
 * recorded for the published version — not values minted by a rogue
 * registry. That pin is worthless if a stray `NPM_CONFIG_REGISTRY` (or a
 * `.npmrc` discovered via these path hints) silently points npm at a
 * different registry: such a registry could serve a tarball npmjs.org
 * never signed and answer `npm view ... dist.integrity` with a matching
 * (attacker-chosen) hash, so BOTH the audit and the hash check would
 * "pass" against the wrong source of truth.
 *
 * Scope of what stripping these BUYS (combined with the `--registry=`
 * flag and the force-set pin in `npmRegistryPinnedEnv`): the verification
 * inputs are always fetched FROM npmjs.org. It does NOT, on its own,
 * re-hash the bytes npm extracted onto disk — that gap is covered by the
 * post-install `dist.integrity` cross-check (registry-recorded hash vs.
 * the integrity npm resolved into the staged lockfile) plus
 * `npm audit signatures` (registry signature + provenance). Tampering of
 * the staged tree AFTER npm extracts it, by a local attacker with write
 * access to the staging prefix, is OUT OF SCOPE: such an attacker can
 * tamper the live install directly, so the self-update gate is not the
 * relevant control.
 *
 * These are NOT secrets — they are stripped from the npm child env in
 * the update path so the explicit `--registry=` flag is the SOLE source
 * of truth and cannot be overridden. Kept separate from
 * SENSITIVE_ENV_VARS (which is about secret EXFILTRATION) because the
 * threat is different (registry HIJACK) and only the update path needs
 * the strip — general subprocesses (python/ollama) have no business
 * reading npm config either, but conflating the two lists would change
 * sanitizedEnvForSubprocess' contract for every caller.
 */
export const NPM_REGISTRY_OVERRIDE_ENV_VARS: readonly string[] = [
  // Canonical registry override (npm reads NPM_CONFIG_<key> for every
  // config key; `registry` is the one that matters here).
  'NPM_CONFIG_REGISTRY',
  // Scoped-registry override for the @synapseia-network scope. npm maps
  // `@synapseia-network:registry` config to this env var name.
  'NPM_CONFIG_@SYNAPSEIA-NETWORK:REGISTRY',
  // Legacy lowercase form some npm versions still honour.
  'npm_config_registry',
  // `.npmrc` discovery hints — point npm at an attacker-controlled
  // userconfig/globalconfig that could set `registry=`. Stripping these
  // forces npm to fall back to our `--registry=` flag.
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_GLOBALCONFIG',
  'npm_config_userconfig',
  'npm_config_globalconfig',
  // HTTP(S) proxy redirection — a proxy could MITM the connection to the
  // pinned registry and swap the bytes on the wire. Stripping the proxy
  // env keeps the update path talking to npmjs.org directly; the registry
  // signature / provenance audit and the dist.integrity cross-check then
  // confirm the bytes match what npmjs.org recorded for the version.
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'npm_config_proxy',
  'npm_config_https_proxy',
] as const;

/**
 * Return a shallow clone of `process.env` hardened for the self-update
 * npm child: every registry/proxy/.npmrc-discovery override stripped,
 * and `npm_config_registry` force-set to the pinned public registry so
 * even a config key we have not enumerated cannot win over the explicit
 * pin. The caller still passes `--registry=` on the command line (CLI
 * flag > env > .npmrc in npm's precedence), so this is defence in depth.
 *
 * This hardens WHERE npm fetches from (always npmjs.org). It does not by
 * itself verify the extracted bytes — that is the job of the install
 * path's two gates (the dist.integrity hash cross-check and
 * `npm audit signatures`), both of which rely on this pin so their
 * trust inputs come from the real registry rather than a redirected one.
 *
 * `extra` is merged last (e.g. NPM_CONFIG_PREFIX for the staging dir).
 */
export function npmRegistryPinnedEnv(
  pinnedRegistry: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...process.env };
  for (const k of NPM_REGISTRY_OVERRIDE_ENV_VARS) {
    if (k in clone) delete clone[k];
  }
  // Force the pinned registry through the env layer too, so a config key
  // outside our strip list still resolves to npmjs.org.
  clone.npm_config_registry = pinnedRegistry;
  return { ...clone, ...extra };
}

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
