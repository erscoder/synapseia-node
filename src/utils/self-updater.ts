import { execSync, execFileSync, spawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { join, dirname, relative } from 'path';
import { valid } from 'semver';
import logger from './logger';
import { npmRegistryPinnedEnv } from './subprocess-env';

// `__filename` is a CJS global in jest and a tsup-injected shim in the
// production ESM bundle (`shims: true` in tsup.config.ts). Both paths
// resolve before any code in this file runs, so we can use it directly.

export enum InstallType {
  NPM_GLOBAL = 'npm_global',
  GIT_CLONE = 'git_clone',
  BINARY = 'binary',
  UNKNOWN = 'unknown',
}

/**
 * Detect how the node CLI was installed.
 */
export function detectInstallType(): InstallType {
  // Prefer a path-based check against THIS module's location: if we're
  // running from any known npm-install layout (user-prefix from a
  // previous self-update, bundled-runtime prefix from install_synapseia_node,
  // or a system prefix), classify as NPM_GLOBAL. `npm root -g` only ever
  // reports the SYSTEM prefix, so the user-prefix install used by the
  // sudo-free self-update path was silently classified as UNKNOWN and
  // the update never ran. Same goes for the bundled-runtime prefix.
  try {
    const myDir = dirname(__filename);
    const NPM_PREFIXES = [
      join(homedir(), '.synapseia', 'npm-global'),
      join(homedir(), '.synapseia', 'node'),
      '/opt/homebrew/lib/node_modules',
      '/usr/local/lib/node_modules',
      '/usr/lib/node_modules',
    ];
    for (const prefix of NPM_PREFIXES) {
      // path-prefix match — accept both flat (npm) and nested (workspace) layouts.
      if (myDir.startsWith(prefix + '/') || myDir === prefix) {
        return InstallType.NPM_GLOBAL;
      }
    }
  } catch { /* fall through */ }

  try {
    // Fallback: `npm root -g` system check covers nvm/volta/fnm layouts
    // we don't hard-code above.
    const npmGlobalRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (existsSync(join(npmGlobalRoot, '@synapseia-network', 'node', 'package.json'))) {
      return InstallType.NPM_GLOBAL;
    }
  } catch { /* not npm global */ }

  // git clone: .git dir exists somewhere up the tree. Walk up from this
  // module's location looking for the first .git/ — robust to dev vs
  // bundled layouts.
  if (findGitRoot(dirname(__filename))) {
    return InstallType.GIT_CLONE;
  }

  // Binary: compiled single-file (Tauri bundles, pkg, etc.)
  if (process.pkg || (process as any).__nexe) {
    return InstallType.BINARY;
  }

  return InstallType.UNKNOWN;
}

export interface SelfUpdateResult {
  success: boolean;
  installType: InstallType;
  message: string;
}

/**
 * Resolve the npm prefix the CURRENT binary was installed into. Looks
 * for `/lib/node_modules/@synapseia-network/node` in this module's
 * dirname and returns the parent of `lib/`. Returns null when the
 * layout is unrecognisable (compiled binary, raw dev tree, etc.).
 *
 * Pre-0.8.49 the self-update hard-coded `~/.synapseia/npm-global` as
 * the upgrade target. Operators that installed via a regular
 * `npm i -g` (system prefix `/usr/local` or homebrew-managed) had
 * the update land in the user prefix while their PATH still pointed
 * at the system binary — every boot detected an update and looped
 * because the *running* binary never moved.
 */
function getRunningInstallPrefix(): string | null {
  try {
    const myDir = dirname(__filename);
    const marker = '/lib/node_modules/';
    const idx = myDir.indexOf(marker);
    if (idx >= 0) return myDir.slice(0, idx);
  } catch { /* fall through */ }
  return null;
}

/** Defensive shell-quote for the version spec we pass through `execSync`
 *  string form. The version comes from the npm dist-tags `latest` (and is
 *  semver-validated by the caller), but the rule is "every external string
 *  is hostile" — quoting is cheap and audit-friendly. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The published package name. Single constant so the path-building below and
 *  the integrity check can never drift apart. */
const PACKAGE_NAME = '@synapseia-network/node';

/**
 * The ONLY registry the self-update path will ever talk to. The version
 * CHECK upstream (update-checker.ts) already pins this; the actual
 * install/download/verify MUST pin it too, otherwise a stray
 * `NPM_CONFIG_REGISTRY` / `.npmrc` could redirect npm to a rogue
 * registry that serves a trojaned tarball. Passed as `--registry=` on
 * EVERY npm command in this file and force-set in the child env via
 * `npmRegistryPinnedEnv`.
 */
const PINNED_REGISTRY = 'https://registry.npmjs.org';

/** Default install timeout (10 min). 120s was the proven pod failure point —
 *  the full dependency tree on a slow registry/disk takes 6-10+ minutes, so
 *  a 120s SIGTERM kills npm mid-install (ETIMEDOUT) and, with the old in-place
 *  `npm install -g`, left the live global package corrupt. Overridable via
 *  `SYN_SELFUPDATE_TIMEOUT_MS` for operators on especially slow hosts. */
const DEFAULT_SELFUPDATE_TIMEOUT_MS = 600_000;

/** Short, DEDICATED timeout for the post-install verification gates
 *  (`npm audit signatures` + `npm view ... dist.integrity`). These are
 *  small metadata round-trips, NOT a full dependency-tree install, so they
 *  must NOT reuse the ~10-min install timeout: an update CHECK runs at boot
 *  and a hung audit on the install budget would stall startup for minutes.
 *  Fail-closed (treated as "unverifiable") if either gate exceeds this.
 *  Overridable via `SYN_SELFUPDATE_VERIFY_TIMEOUT_MS` for slow links. */
const DEFAULT_SELFUPDATE_VERIFY_TIMEOUT_MS = 60_000;

/** Resolve the install timeout. Honours `SYN_SELFUPDATE_TIMEOUT_MS` when it is
 *  a positive integer; otherwise falls back to the 10-minute default. Exported
 *  pure helper so the env-override logic is unit-testable without spawning npm. */
export function resolveSelfUpdateTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SYN_SELFUPDATE_TIMEOUT_MS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_SELFUPDATE_TIMEOUT_MS;
}

/** Resolve the SHORT verification timeout for the signature/integrity gates.
 *  Honours `SYN_SELFUPDATE_VERIFY_TIMEOUT_MS` (positive integer ms); otherwise
 *  the 60s default. Separate from `resolveSelfUpdateTimeoutMs` so a boot-time
 *  update check never blocks for the full install budget on a hung audit. */
export function resolveSelfUpdateVerifyTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SYN_SELFUPDATE_VERIFY_TIMEOUT_MS;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_SELFUPDATE_VERIFY_TIMEOUT_MS;
}

export interface IntegrityResult {
  ok: boolean;
  reason?: string;
}

/**
 * Integrity self-check for a candidate `@synapseia-network/node` install.
 *
 * `packageDir` is the directory that should contain the package's
 * `package.json` (i.e. `<prefix>/lib/node_modules/@synapseia-network/node`).
 * The install is considered complete + correct iff ALL hold:
 *   1. `package.json` exists and parses;
 *   2. its `name` is `@synapseia-network/node`;
 *   3. its `version` strictly equals `expectedVersion`;
 *   4. the bin entry-point `dist/bootstrap.js` exists (what `bin/syn` links to);
 *   5. at least one of `dist/scripts/` or `scripts/` exists and is NON-EMPTY
 *      (a half-extracted tree typically loses these directories first).
 *
 * Pure-ish (filesystem reads only, no spawning, no mutation) so it can be
 * unit-tested by mocking `fs`. Never throws — any unexpected error is
 * captured and reported as `ok:false` so callers stay fail-closed.
 */
export function verifyInstalledPackage(
  packageDir: string,
  expectedVersion: string,
): IntegrityResult {
  try {
    const pkgJsonPath = join(packageDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      return { ok: false, reason: 'package.json missing' };
    }

    let parsed: { name?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as typeof parsed;
    } catch {
      return { ok: false, reason: 'package.json unparseable' };
    }

    if (parsed.name !== PACKAGE_NAME) {
      return { ok: false, reason: `unexpected package name "${String(parsed.name)}"` };
    }
    if (typeof parsed.version !== 'string' || parsed.version !== expectedVersion) {
      return {
        ok: false,
        reason: `version mismatch: found "${String(parsed.version)}" expected "${expectedVersion}"`,
      };
    }

    // Entry-point the bin symlink resolves to. A truncated install loses dist/.
    if (!existsSync(join(packageDir, 'dist', 'bootstrap.js'))) {
      return { ok: false, reason: 'dist/bootstrap.js missing' };
    }

    // At least one scripts dir must exist AND be non-empty.
    const scriptDirsNonEmpty = ['dist/scripts', 'scripts'].some((rel) => {
      const dir = join(packageDir, rel);
      try {
        return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
      } catch {
        return false;
      }
    });
    if (!scriptDirsNonEmpty) {
      return { ok: false, reason: 'scripts directory missing or empty' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `integrity check error: ${(err as Error).message}` };
  }
}

/**
 * REGISTRY-SIGNATURE + PROVENANCE gate for a freshly-staged install,
 * BEFORE the atomic swap. `verifyInstalledPackage` only detects a
 * *truncated* tree (right name/version, dist/ + scripts/ present). This
 * gate adds the registry's own attestations on top.
 *
 * WHAT THIS VERIFIES — and what it does NOT.
 * `npm audit signatures` verifies, AGAINST THE PINNED REGISTRY:
 *   (a) the npm registry's ECDSA signature over the published version's
 *       recorded tarball integrity/metadata, and
 *   (b) the sigstore provenance attestation tying that published version
 *       to the GitHub Actions build (`publish-npm.yml`, `--provenance`
 *       under OIDC Trusted Publishing).
 * It checks the REGISTRY's signed record of the published version. It
 * does NOT re-hash the bytes npm extracted onto disk — empirically,
 * mutating an already-extracted file still yields `npm audit signatures`
 * exit 0, because the subcommand audits the registry's signed metadata
 * for the resolved version, not the on-disk tree.
 *
 * So, combined with the registry pin + env neutralisation, this gate
 * DEFEATS: a rogue/hijacked registry serving a tarball the real npmjs.org
 * never signed; a version published WITHOUT valid sigstore provenance
 * (e.g. via a stolen npm token but no GitHub-OIDC CI build); and an
 * on-the-wire MITM tarball swap (the swapped bytes won't match the
 * registry's signed integrity).
 *
 * It does NOT defend against tampering of the STAGED TREE after npm
 * extracted it — a local attacker with write access to the staging
 * prefix is OUT OF SCOPE here (such an attacker can tamper the live
 * install directly, so this gate is not the relevant control). The
 * companion on-disk hash cross-check (`verifyStagedIntegrity`) compares
 * the integrity npm RESOLVED into the staged lockfile against the
 * registry's `dist.integrity`, catching a registry that served divergent
 * metadata; neither gate claims to re-hash arbitrary post-extract edits.
 *
 * FAIL-CLOSED on EVERYTHING: a non-zero exit, a thrown error (offline /
 * registry unreachable / npm too old to support the subcommand), OR
 * output that does not explicitly confirm verification, all return
 * `ok:false`. We never swap on an unverifiable install — an unreachable
 * registry means "skip the update", never "proceed unverified".
 *
 * Uses its OWN short timeout (`DEFAULT_SELFUPDATE_VERIFY_TIMEOUT_MS`), not the
 * ~10-min install timeout, so a boot-time update check cannot stall on a
 * hung audit. The raw audit output is logged on reject for diagnosability.
 *
 * `execFileSync` (NOT a shell string): argv is a fixed literal array, no
 * shell, no interpolation of any external value → no command-injection
 * surface. Never throws (errors are captured → `ok:false`).
 */
export function verifyStagedSignatures(
  stagedPackageDir: string,
  expectedVersion: string,
): IntegrityResult {
  let out: string;
  try {
    // `npm audit signatures` verifies registry signatures AND provenance
    // attestations for the dependency tree rooted at `cwd`. We point it
    // at the staged package dir so it audits the freshly-downloaded
    // @synapseia-network/node, not the host's unrelated global tree.
    //
    // --registry pins npmjs.org (CLI flag beats env beats .npmrc); the
    // child env strips every registry/proxy/.npmrc override and force-
    // sets npm_config_registry to the same pin — so neither a stray env
    // var nor a discovered .npmrc can redirect the verification.
    out = execFileSync(
      'npm',
      ['audit', 'signatures', `--registry=${PINNED_REGISTRY}`],
      {
        cwd: stagedPackageDir,
        encoding: 'utf-8',
        // DEDICATED short timeout (NOT the ~10-min install budget) — a
        // boot-time update check must not stall on a hung audit.
        timeout: resolveSelfUpdateVerifyTimeoutMs(),
        stdio: 'pipe',
        env: npmRegistryPinnedEnv(PINNED_REGISTRY),
      },
    );
  } catch (err) {
    // Non-zero exit (signature/attestation FAILURE), offline, registry
    // unreachable, or npm too old to support the subcommand. ALL of these
    // are fail-closed: we do not trust the staged tree.
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const combined =
      `${e.stdout ? String(e.stdout) : ''}${e.stderr ? String(e.stderr) : ''}`.trim();
    // Log the RAW audit/error output for diagnosability — a rejected
    // update is a security-relevant event and operators need the npm
    // wording to tell "registry down" from "signature actually invalid".
    logger.warn(
      `[SelfUpdate][SECURITY] npm audit signatures rejected v${expectedVersion}: ` +
        `${combined || e.message || 'unknown error'}`,
    );
    return {
      ok: false,
      reason:
        (`signature verification failed/unavailable: ` +
          `${combined || e.message || 'unknown error'}`).slice(0, 300),
    };
  }

  // Even on exit 0 we POSITIVELY confirm verification rather than trust a
  // silent success. `npm audit signatures` prints "verified N package(s)"
  // on success and "X package(s) have invalid/missing registry
  // signatures" / "missing ... attestation" on failure. We require an
  // explicit "verified" token AND no invalid/missing wording — fail-
  // closed if either condition is unmet, so a future npm output change
  // that drops the failure wording cannot be misread as success.
  const lower = out.toLowerCase();
  const badWording =
    /(invalid|missing|untrusted|tamper|error)/.test(lower) &&
    /(signature|attestation|provenance)/.test(lower);
  const confirmedVerified = /\bverified\b/.test(lower);
  if (badWording || !confirmedVerified) {
    // Log the RAW audit output on reject — a "verified" token that never
    // appeared, or failure wording on an exit-0 run, is exactly what an
    // operator needs to diagnose a stuck update.
    logger.warn(
      `[SelfUpdate][SECURITY] npm audit signatures did not confirm v${expectedVersion}: ` +
        `${out.trim()}`,
    );
    return {
      ok: false,
      reason:
        (`signature audit did not positively confirm verification for ` +
          `v${expectedVersion}: ${out.trim()}`).slice(0, 300),
    };
  }
  return { ok: true };
}

/**
 * Extract the resolved `integrity` (SRI `sha512-…`) that npm recorded for
 * `@synapseia-network/node` in the staged hidden lockfile
 * (`<stagedModulesDir>/.package-lock.json`). When `npm install -g
 * --prefix=<staging>` extracts the package, it writes this lockfile with
 * an entry whose `integrity` is the hash npm computed for the tarball it
 * actually fetched. Returns null when the lockfile / entry / integrity is
 * absent or unparseable (caller treats null as fail-closed).
 *
 * Pure-ish: filesystem read only, never throws.
 */
export function readStagedResolvedIntegrity(stagedModulesDir: string): string | null {
  try {
    const lockPath = join(stagedModulesDir, '.package-lock.json');
    if (!existsSync(lockPath)) return null;
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      packages?: Record<string, { integrity?: unknown }>;
    };
    const pkgs = parsed.packages;
    if (!pkgs || typeof pkgs !== 'object') return null;
    // npm keys the hidden lockfile by install path relative to the dir the
    // lockfile lives in: `node_modules/@synapseia-network/node`. Accept that
    // canonical key; fall back to scanning for any entry whose key ends with
    // the package path (defensive against npm layout shifts).
    const canonical = `node_modules/${PACKAGE_NAME}`;
    const entry =
      pkgs[canonical] ??
      Object.entries(pkgs).find(([k]) => k.endsWith(`node_modules/${PACKAGE_NAME}`))?.[1];
    const integrity = entry?.integrity;
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) return null;
    return integrity;
  } catch {
    return null;
  }
}

/**
 * ARTIFACT-INTEGRITY gate (defence-in-depth) for a freshly-staged install,
 * BEFORE the atomic swap. Complements `verifyStagedSignatures`: that gate
 * checks the registry's SIGNATURE + provenance over the published version;
 * this gate cross-checks the TARBALL HASH.
 *
 * WHAT THIS VERIFIES — and what it does NOT.
 * The current flow extracts via `npm install -g --prefix=<staging>` (it
 * does NOT download a standalone `.tgz`), so npm records the integrity it
 * computed for the fetched tarball in the staged hidden lockfile. We:
 *   1. read that resolved `integrity` (`readStagedResolvedIntegrity`), and
 *   2. fetch the published `dist.integrity` for the EXACT target version
 *      from the PINNED registry via `npm view`, and
 *   3. require them to be byte-equal.
 * A registry that served DIVERGENT metadata (a tarball whose hash differs
 * from what npmjs.org recorded for the version) is caught here even if the
 * structural gate passed. Like the signature gate this checks recorded /
 * resolved hashes; it does NOT re-hash arbitrary post-extract edits, and
 * staging-dir tampering by a local attacker with write access remains OUT
 * OF SCOPE (that attacker can tamper the live install directly).
 *
 * FAIL-CLOSED on EVERYTHING: missing/unparseable staged integrity, `npm
 * view` non-zero/throw/timeout/offline, a malformed published value, or a
 * mismatch → `ok:false`. An unverifiable hash means "skip the update".
 * Uses the SHORT dedicated verify timeout. Logs the compared values on
 * reject for diagnosability.
 *
 * `execFileSync` (NOT a shell string): fixed argv, the only interpolated
 * value is the caller-supplied (semver-validated) version inside an
 * argument that the shell never sees → no command-injection surface.
 */
export function verifyStagedIntegrity(
  stagedModulesDir: string,
  expectedVersion: string,
): IntegrityResult {
  const resolved = readStagedResolvedIntegrity(stagedModulesDir);
  if (!resolved) {
    logger.warn(
      `[SelfUpdate][SECURITY] could not read staged resolved integrity for v${expectedVersion} ` +
        `from ${stagedModulesDir}/.package-lock.json`,
    );
    return { ok: false, reason: 'staged resolved integrity missing/unreadable' };
  }

  let published: string;
  try {
    // `npm view <pkg>@<version> dist.integrity` returns the SRI string the
    // registry recorded for that exact version, fetched over the PINNED
    // registry with the override env neutralised. The version is semver-
    // validated by the caller and passed as a single execFile argv element
    // (no shell), so it cannot inject extra npm flags or shell tokens.
    const raw = execFileSync(
      'npm',
      ['view', `${PACKAGE_NAME}@${expectedVersion}`, 'dist.integrity', `--registry=${PINNED_REGISTRY}`],
      {
        encoding: 'utf-8',
        timeout: resolveSelfUpdateVerifyTimeoutMs(),
        stdio: 'pipe',
        env: npmRegistryPinnedEnv(PINNED_REGISTRY),
      },
    );
    published = String(raw).trim();
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const combined =
      `${e.stdout ? String(e.stdout) : ''}${e.stderr ? String(e.stderr) : ''}`.trim();
    logger.warn(
      `[SelfUpdate][SECURITY] npm view dist.integrity failed/unavailable for v${expectedVersion}: ` +
        `${combined || e.message || 'unknown error'}`,
    );
    return {
      ok: false,
      reason:
        (`published integrity fetch failed/unavailable: ` +
          `${combined || e.message || 'unknown error'}`).slice(0, 300),
    };
  }

  if (!published.startsWith('sha512-')) {
    logger.warn(
      `[SelfUpdate][SECURITY] malformed published dist.integrity for v${expectedVersion}: "${published}"`,
    );
    return { ok: false, reason: `malformed published integrity: "${published}"`.slice(0, 300) };
  }

  if (published !== resolved) {
    // The registry served a tarball whose hash differs from the one it
    // recorded for this version — divergent metadata. NEVER swap.
    logger.warn(
      `[SelfUpdate][SECURITY] integrity MISMATCH for v${expectedVersion}: ` +
        `staged=${resolved} published=${published}. Live install left untouched — NO swap.`,
    );
    return {
      ok: false,
      reason:
        (`integrity mismatch: staged ${resolved} != published ${published}`).slice(0, 300),
    };
  }

  return { ok: true };
}

/**
 * Atomic swap of a freshly-staged, integrity-verified package into the live
 * prefix. Both `liveModulesDir` and `stagedPackageDir` are assumed on the SAME
 * filesystem (the staging dir is a sibling under the same prefix root), so
 * `renameSync` is atomic — there is NO window in which the live package is
 * partially present.
 *
 * Sequence:
 *   1. rename live `@synapseia-network/node` → `@synapseia-network/node.bak`
 *      (instant; if absent, fresh install — skip).
 *   2. rename staged tree → live location (instant).
 *   3. on success: rm `.bak` recursively.
 *   4. on ANY failure after step 1: rename `.bak` back to restore the live
 *      install exactly as it was, then rethrow — the live tree is untouched.
 *
 * The live `@synapseia-network/` scope dir is created if missing (npm always
 * creates it, but staging-only prefixes may not have the live one yet).
 */
function atomicSwapPackage(liveModulesDir: string, stagedPackageDir: string): void {
  const scopeDir = join(liveModulesDir, '@synapseia-network');
  const liveDir = join(scopeDir, 'node');
  const bakDir = join(scopeDir, 'node.bak');

  mkdirSync(scopeDir, { recursive: true });

  // Clean a stale .bak from a previously-interrupted swap (best effort).
  if (existsSync(bakDir)) {
    try { rmSync(bakDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const hadLive = existsSync(liveDir);
  if (hadLive) {
    renameSync(liveDir, bakDir); // step 1 — instant, atomic on same FS
  }
  try {
    renameSync(stagedPackageDir, liveDir); // step 2 — instant, atomic on same FS
  } catch (err) {
    // step 4 — restore the previous live install, leave it exactly as before.
    if (hadLive && !existsSync(liveDir) && existsSync(bakDir)) {
      try { renameSync(bakDir, liveDir); } catch { /* keep .bak for manual recovery */ }
    }
    throw err;
  }
  // step 3 — drop the old version now that the new one is in place.
  if (hadLive) {
    try { rmSync(bakDir, { recursive: true, force: true }); } catch { /* harmless leftover */ }
  }
}

/**
 * Re-point the `<prefix>/bin/syn` and `<prefix>/bin/synapseia` symlinks at the
 * just-swapped package's `dist/bootstrap.js`. npm normally manages these, but
 * because we move the package dir behind npm's back the existing links still
 * resolve to the right inode (same path), so this is defensive: it only
 * rewrites a link when it is missing or dangling. Best-effort — a failure here
 * does NOT corrupt the install (the package itself is already swapped in), so
 * we log and continue rather than rolling back a valid update.
 */
function ensureBinSymlinks(prefix: string, liveModulesDir: string): void {
  const target = join(liveModulesDir, '@synapseia-network', 'node', 'dist', 'bootstrap.js');
  const binDir = join(prefix, 'bin');
  for (const name of ['syn', 'synapseia']) {
    const link = join(binDir, name);
    try {
      // existsSync follows symlinks → false for a dangling link.
      if (existsSync(link)) continue;
      mkdirSync(binDir, { recursive: true });
      try { unlinkSync(link); } catch { /* not present / not a link */ }
      // Relative link keeps the install relocatable.
      symlinkSync(relative(binDir, target), link);
    } catch (err) {
      logger.warn(`[SelfUpdate] could not refresh bin symlink ${name}: ${(err as Error).message}`);
    }
  }
}

/**
 * Attempt to self-update the node CLI.
 *
 * Trust model (2026-05-22 — DELIBERATE removal of the coord-signed-manifest
 * gate). The npm registry's `latest` dist-tag is the SOLE source of truth
 * for what to install: the npm publish account is the de-facto release
 * authority and CI is the only publisher. The update DECISION (is there a
 * newer version?) is made upstream by `preflightVersionCheck`
 * (update-checker.ts) reading the npm dist-tags; this function is handed the
 * already-resolved target version and installs it directly:
 *
 *   npm install -g @synapseia-network/node@<targetVersion> --ignore-scripts
 *
 * `--ignore-scripts` blocks `preinstall` / `postinstall` / `prepare`
 * lifecycle scripts from running during install. The exact target version
 * is PINNED (never the floating `@latest`), so the install is reproducible
 * and cannot be moved out from under us by a registry change between the
 * check and the install. The REGISTRY itself is also pinned on the install
 * (`--registry=registry.npmjs.org` + a sanitised child env, see
 * npmRegistryPinnedEnv) so a stray NPM_CONFIG_REGISTRY / .npmrc cannot
 * redirect the download to a rogue registry.
 *
 * NEITHER of those, on its own, stops a tarball that the real npmjs.org
 * never signed (rogue/hijacked registry), a version published without
 * valid provenance (stolen token, no OIDC CI build), or an on-the-wire
 * MITM swap. Two registry-anchored gates run on the staged tree BEFORE
 * the atomic swap — see the staging sequence below. Trust root = what
 * npmjs.org recorded for the published version (registry signature +
 * sigstore provenance + dist.integrity). Note: these gates verify the
 * registry's signed record / recorded hash, NOT a re-hash of arbitrary
 * post-extract on-disk edits; a local attacker with write access to the
 * staging prefix is out of scope (they can tamper the live install).
 *
 * ATOMIC, NON-DESTRUCTIVE install (the 0.8.116 fix). The pod's slow npm took
 * 6-10+ min to fetch the full tree, so the old 120s timeout SIGTERM-killed
 * `npm install -g` mid-write — and because that command mutates the live
 * global package in place, a killed install left it PARTIAL (no dist/, no
 * package.json) and the node could not even boot on restart, looping every
 * 30 min and re-corrupting. The fix:
 *   1. Raise the timeout to 10 min (env-overridable, see resolveSelfUpdateTimeoutMs).
 *   2. Install into a SEPARATE staging prefix (sibling of the live prefix,
 *      same filesystem) so npm builds a COMPLETE tree there without ever
 *      touching the live package.
 *   3. Verify the staged tree, THREE gates, all fail-closed:
 *      a. STRUCTURAL (verifyInstalledPackage): package.json present,
 *         version === target, dist/bootstrap.js present, scripts/ non-empty
 *         — catches a truncated extract.
 *      b. REGISTRY SIGNATURE + PROVENANCE (verifyStagedSignatures):
 *         `npm audit signatures` over the PINNED registry verifies the
 *         registry's signature over the published version + sigstore
 *         provenance attestation. Defeats a rogue/unsigned-publish/MITM
 *         vector. Does NOT re-hash on-disk bytes. Trust root = provenance
 *         published by CI (`publish-npm.yml`, `--provenance` + OIDC).
 *      c. ARTIFACT INTEGRITY (verifyStagedIntegrity, defence-in-depth):
 *         cross-checks the `integrity` npm RESOLVED into the staged
 *         lockfile against `npm view <pkg>@<target> dist.integrity` over
 *         the PINNED registry. Catches a registry that served divergent
 *         metadata. Like (b) it checks recorded/resolved hashes, not a
 *         re-hash of arbitrary post-extract edits.
 *      Gates (b) and (c) use a SHORT dedicated verify timeout, not the
 *      ~10-min install budget, so a boot-time check cannot stall.
 *   4. Only on ALL THREE gates passing, atomically `rename()` the staged
 *      package over the live one (old → .bak → swap → drop .bak; restore
 *      .bak on failure).
 * If the install times out / fails / fails ANY verification gate (incl. a
 * registry unreachable for the signature audit or the integrity view),
 * staging is cleaned up and the LIVE install is left byte-for-byte
 * untouched. There is no window in which the live package is partial OR
 * unverified.
 *
 * Fail-closed: any failure returns `{success:false}` and the caller keeps
 * the node on its current version. Only NPM_GLOBAL installs self-update;
 * git-clone and binary installs still require manual intervention.
 */
export async function attemptSelfUpdate(targetVersion: string): Promise<SelfUpdateResult> {
  const installType = detectInstallType();

  switch (installType) {
    case InstallType.NPM_GLOBAL: {
      if (!valid(targetVersion)) {
        return {
          success: false,
          installType,
          message: `Refusing self-update: target version "${targetVersion}" is not valid semver.`,
        };
      }

      // Staging dir we must clean up on every exit path. Declared here so the
      // catch block can also remove it if npm threw mid-install.
      let stagingPrefix: string | null = null;
      try {
        logger.log(
          `[SelfUpdate] Installing @synapseia-network/node@${targetVersion} from npm with --ignore-scripts...`,
        );
        // Target the SAME prefix the running binary was loaded from
        // — otherwise the update lands in a different prefix and the
        // operator's PATH still resolves to the stale binary, kicking
        // off an infinite "update available" loop on every boot.
        //
        // Fallback to the user-owned `~/.synapseia/npm-global` when
        // the running prefix can't be detected (compiled bundle, dev
        // tree, …). The user prefix avoids sudo prompts that would
        // hang a Tauri-spawned CLI without a TTY.
        const runningPrefix = getRunningInstallPrefix();
        const targetPrefix = runningPrefix ?? join(homedir(), '.synapseia', 'npm-global');
        mkdirSync(targetPrefix, { recursive: true });
        logger.log(`[SelfUpdate] target prefix: ${targetPrefix}`);

        // Staging prefix: a sibling under the SAME prefix root so it is on the
        // same filesystem as the live `lib/node_modules`, which guarantees the
        // final swap `rename()` is atomic (cross-FS rename would EXDEV).
        stagingPrefix = join(targetPrefix, `.syn-update-staging-${process.pid}`);
        // Always start from a clean staging dir (drop any leftover from a
        // previously-interrupted attempt).
        try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* none yet */ }
        mkdirSync(stagingPrefix, { recursive: true });

        const timeoutMs = resolveSelfUpdateTimeoutMs();
        // PINNED version (never floating `@latest`): the target was resolved
        // from npm dist-tags upstream; pinning makes the install reproducible
        // and immune to a registry change between the check and the install.
        //
        // NPM_CONFIG_PREFIX points at the STAGING prefix, so npm builds the
        // complete tree under <staging>/lib/node_modules WITHOUT touching the
        // live install. A timeout/kill here corrupts only the throwaway
        // staging dir, never the running binary.
        // --registry PINS npmjs.org on the actual install (the version
        // CHECK was already pinned; the install must be too, or an
        // attacker-influenced NPM_CONFIG_REGISTRY/.npmrc could redirect the
        // DOWNLOAD to a rogue registry). The child env strips every
        // registry/proxy/.npmrc override and force-sets the pin, so the
        // CLI flag is the sole source of truth (CLI > env > .npmrc).
        execSync(
          `npm install -g @synapseia-network/node@${shellQuote(targetVersion)} ` +
            `--ignore-scripts --registry=${PINNED_REGISTRY}`,
          {
            encoding: 'utf-8',
            timeout: timeoutMs,
            stdio: 'pipe',
            env: npmRegistryPinnedEnv(PINNED_REGISTRY, {
              NPM_CONFIG_PREFIX: stagingPrefix,
            }),
          },
        );

        // VERIFY the staged tree before we touch the live install. Three
        // gates, in order; ALL must pass or we leave the live install
        // byte-for-byte untouched and skip the update.
        //
        // Gate 1 — structural (truncation): right name/version, dist/
        // bootstrap + scripts present. Catches a half-extracted tree.
        const stagedModulesDir = join(stagingPrefix, 'lib', 'node_modules');
        const stagedPackageDir = join(stagedModulesDir, '@synapseia-network', 'node');
        const integrity = verifyInstalledPackage(stagedPackageDir, targetVersion);
        if (!integrity.ok) {
          // Live install UNTOUCHED — we never started the swap.
          try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* best effort */ }
          stagingPrefix = null;
          return {
            success: false,
            installType,
            message:
              `Staged update to v${targetVersion} failed integrity check ` +
              `(${integrity.reason}). Live install left untouched.`,
          };
        }

        // Gate 2 — CRYPTOGRAPHIC (trojaned-but-well-formed tarball): npm
        // registry signature + sigstore provenance attestation over the
        // pinned registry. This is the real supply-chain defence — gate 1
        // would happily pass a tampered tarball with the correct name and
        // version. Fail-closed: ANY mismatch / error / unreachable
        // registry / unverifiable result leaves the live install
        // untouched and SKIPS the update (never proceeds unverified).
        const signatures = verifyStagedSignatures(stagedPackageDir, targetVersion);
        if (!signatures.ok) {
          logger.warn(
            `[SelfUpdate][SECURITY] Refusing update to v${targetVersion}: ` +
              `staged tarball failed cryptographic verification ` +
              `(${signatures.reason}). Live install left untouched — NO swap.`,
          );
          try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* best effort */ }
          stagingPrefix = null;
          return {
            success: false,
            installType,
            message:
              `Staged update to v${targetVersion} failed cryptographic ` +
              `signature/provenance verification (${signatures.reason}). ` +
              `Live install left untouched.`,
          };
        }

        // Gate 3 — ARTIFACT INTEGRITY (defence-in-depth): cross-check the
        // integrity npm RESOLVED into the staged lockfile against the
        // published dist.integrity fetched over the pinned registry. This
        // catches a registry that served DIVERGENT metadata (a tarball
        // whose hash differs from what npmjs.org recorded for the version)
        // — a vector the signature audit's registry-record check cannot.
        // Fail-closed: missing staged integrity, unreachable `npm view`,
        // malformed value, or any mismatch leaves the live install
        // untouched and SKIPS the update.
        const artifact = verifyStagedIntegrity(stagedModulesDir, targetVersion);
        if (!artifact.ok) {
          logger.warn(
            `[SelfUpdate][SECURITY] Refusing update to v${targetVersion}: ` +
              `staged artifact failed integrity cross-check ` +
              `(${artifact.reason}). Live install left untouched — NO swap.`,
          );
          try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* best effort */ }
          stagingPrefix = null;
          return {
            success: false,
            installType,
            message:
              `Staged update to v${targetVersion} failed artifact integrity ` +
              `cross-check (${artifact.reason}). Live install left untouched.`,
          };
        }

        // ATOMIC swap: move the verified staged package over the live one.
        const liveModulesDir = join(targetPrefix, 'lib', 'node_modules');
        mkdirSync(liveModulesDir, { recursive: true });
        atomicSwapPackage(liveModulesDir, stagedPackageDir);
        ensureBinSymlinks(targetPrefix, liveModulesDir);

        // Tear down the now-empty staging prefix (the package dir was moved
        // out; what remains is npm scaffolding + lockfiles).
        try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* harmless */ }
        stagingPrefix = null;

        return {
          success: true,
          installType,
          message:
            `Updated to v${targetVersion} (pinned registry, --ignore-scripts, ` +
            `signature+provenance + dist.integrity verified, atomic swap). Restarting...`,
        };
      } catch (err) {
        // Any failure (timeout, ENOSPC, swap error) — purge staging so a
        // partial tree can't be picked up next time. The live install is
        // untouched unless atomicSwapPackage already restored its own .bak.
        if (stagingPrefix) {
          try { rmSync(stagingPrefix, { recursive: true, force: true }); } catch { /* best effort */ }
        }
        const msg = (err as Error).message ?? String(err);
        if (/EACCES|permission denied|operation not permitted/i.test(msg)) {
          return {
            success: false,
            installType,
            message:
              'npm install -g failed with a permission error. ' +
              'The running binary lives in a write-protected prefix (likely ' +
              '/usr/local or /opt/homebrew). Run `sudo npm install -g ' +
              `@synapseia-network/node@${targetVersion}\` manually, OR reinstall under ` +
              'a user-local Node manager (nvm/volta/fnm) to enable ' +
              'sudo-free auto-updates.',
          };
        }
        return {
          success: false,
          installType,
          message: `npm install -g @synapseia-network/node@${targetVersion} failed: ${msg}`,
        };
      }
    }

    case InstallType.GIT_CLONE:
      return {
        success: false,
        installType,
        message: 'Git clone detected. Run `git pull && npm run build` manually.',
      };

    case InstallType.BINARY:
      return {
        success: false,
        installType,
        message: 'Binary install detected. Download the latest release from GitHub.',
      };

    default:
      return {
        success: false,
        installType,
        message: 'Unknown install type. Update manually: npm i -g @synapseia-network/node',
      };
  }
}

/**
 * Walk up from `start` looking for a directory containing a `.git/`
 * folder. Returns the path to the directory or null. Used by
 * detectInstallType so it works whether this module ships from
 * src/utils/ (dev) or dist/ (production bundle).
 */
function findGitRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Signal that the current process should be relaunched by its host
 * (the desktop UI or the user's shell loop). We do NOT exec a new
 * child here: when this CLI is spawned by the Tauri desktop UI, the
 * UI already keeps a child-process handle and respawns on exit;
 * trying to spawn a child from inside the doomed process produces
 * a lockfile collision (old process still alive, child sees the
 * lock, bails with "Another Synapseia node is already running from
 * the desktop UI").
 *
 * Exit cleanly and let the orchestrator take over. For shell-spawned
 * runs the user will simply see the process exit and can re-run
 * `synapseia start`; we print an explicit `[SELF_UPDATE_RESTART]`
 * line to stdout before exiting so a human in the shell sees the cue
 * and the desktop UI's log tail picks it up.
 */
/**
 * F-node-013 (P30 reviewer-lesson) — graceful shutdown handles surfaced
 * by the caller so we can flush the telemetry ring buffer and stop the
 * libp2p node BEFORE `process.exit(0)`. Previously this function exited
 * immediately, dropping up to 1000 in-memory telemetry events plus any
 * "update applied" / in-flight error context.
 *
 * Each handle is optional: pre-flight callers (which run BEFORE p2p +
 * telemetry are constructed) pass nothing and behave exactly like the
 * pre-fix call site. Steady-state callers from node-runtime pass both.
 *
 * Mirrors the SIGTERM shutdown sequence in node-runtime.ts: emit a
 * shutdown event, drain the ring with a bounded budget, stop p2p.
 */
export interface RestartShutdownHandles {
  /**
   * Stop the telemetry client and flush its ring + spool head with a
   * bounded budget. Implementations should call `drainAll(timeoutMs)`
   * then `stop()`. Errors are swallowed by `restartProcess`.
   */
  stopTelemetry?: (timeoutMs: number) => Promise<void>;
  /**
   * Stop the libp2p node. Errors are swallowed by `restartProcess`.
   */
  stopP2p?: () => Promise<void>;
  /**
   * Release the single-instance lock file synchronously, called right
   * before the detached respawn so the freshly-spawned `syn start`
   * child does not see the dying parent's lock and bail with "Another
   * Synapseia node is already running". No-op when `respawn` is false.
   * Errors are swallowed by `restartProcess`.
   */
  releaseLock?: () => void;
  /**
   * When true, AND the process is NOT supervised by the desktop UI
   * (`SYNAPSEIA_LAUNCH_SOURCE !== 'ui'`), spawn a detached replacement
   * `syn start` before exiting. Required for pods / shell runs that have
   * no host supervisor — a plain `process.exit(0)` would leave them DOWN.
   *
   * Desktop-UI runs keep `respawn` effectively disabled at runtime: the
   * UI already keeps a child-process handle and respawns on exit, so a
   * self-spawned child would collide on the lock file (see the
   * `restartProcess` docblock). The UI gate is enforced inside
   * `restartProcess`, not by the caller, so a mis-set flag cannot break
   * the UI path.
   */
  respawn?: boolean;
}

const SHUTDOWN_BUDGET_MS = 5_000;

/**
 * Spawn a detached replacement `syn start` that survives the parent's
 * exit. Mirrors `.devnet/pod-update-restart.sh`:
 *   - re-runs the SAME argv (the `start` subcommand + any flags the
 *     operator passed, e.g. `--set-name`, `--inference`);
 *   - inherits the full env, so `SYNAPSEIA_KEYSTORE_PASSPHRASE_FILE`
 *     (mounted by the pod / set by `provision-newpod.sh`) is preserved
 *     and the child unlocks the keystore non-interactively;
 *   - `detached: true` + `unref()` so the child is reparented to init
 *     and keeps running after this process dies;
 *   - `stdio: 'inherit'` so the new process writes to the same log file
 *     the pod redirects (`>/var/log/syn.log 2>&1`).
 *
 * Returns true if the child was spawned, false on any failure (the
 * caller then falls back to a plain exit — fail-closed, never throw).
 */
export function respawnDetached(): boolean {
  try {
    // process.argv === [nodeBinary, scriptPath, ...userArgs]. We re-exec
    // the SAME node binary against the SAME bootstrap script + args so
    // the relaunch is byte-identical to how the pod / shell invoked us,
    // just running the freshly-installed code on disk.
    const [, scriptPath, ...userArgs] = process.argv;
    if (!scriptPath) return false;
    const child = spawn(process.execPath, [scriptPath, ...userArgs], {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.unref();
    return true;
  } catch (err) {
    logger.error(`[SelfUpdate] detached respawn failed: ${(err as Error).message}`);
    return false;
  }
}

export async function restartProcess(
  handles: RestartShutdownHandles = {},
): Promise<never> {
  // Operator-facing banner. The first line is the actionable instruction
  // — keep it loud and unambiguous so a human reading the log tail in the
  // desktop UI does not just see "exited" and assume the node crashed.
  logger.log('');
  logger.log('============================================================');
  logger.log('  UPDATE INSTALLED — RESTART REQUIRED');
  logger.log('  A new version of @synapseia-network/node was downloaded.');
  logger.log('  This process is exiting now. To pick up the new code:');
  logger.log('    - Desktop app: click Start again, or quit the app and');
  logger.log('      reopen it so the new CLI is spawned fresh.');
  logger.log('    - Shell users: re-run `synapseia start`.');
  logger.log('  Wallet, identity, and persisted config are unchanged.');
  logger.log('============================================================');
  logger.log('');
  logger.log('[SelfUpdate] Update applied. Flushing telemetry + stopping p2p before exit.');

  // Bounded graceful shutdown. We split the 5s budget between telemetry
  // and p2p — telemetry first so the "update applied" log line (just
  // emitted via logger.log → tap → ring) reaches the coord before the
  // process dies. Each step is timeout-guarded so a hung handle cannot
  // block the relaunch.
  const half = Math.floor(SHUTDOWN_BUDGET_MS / 2);
  if (handles.stopTelemetry) {
    try {
      await Promise.race([
        handles.stopTelemetry(half),
        new Promise<void>((resolve) => setTimeout(resolve, half + 250)),
      ]);
    } catch {
      /* best effort — don't block relaunch on telemetry */
    }
  }
  if (handles.stopP2p) {
    try {
      await Promise.race([
        handles.stopP2p(),
        new Promise<void>((resolve) => setTimeout(resolve, half)),
      ]);
    } catch {
      /* best effort — don't block relaunch on p2p */
    }
  }

  // Mirror to stdout in case logger output is suppressed by a
  // log-level filter; the desktop UI's log tail watches stdout/stderr.
  //
  // F-node-ui-004 (P10): the Tauri UI now requires a canonical, anchored
  // marker `[SELF_UPDATE_RESTART] nonce=<hex>  v<semver>  pid=<digits>`
  // where `nonce` matches `SYNAPSEIA_SELF_UPDATE_NONCE` injected at
  // spawn time. Only the legitimate child process knows the nonce, so a
  // malicious WO / KG ingest / web-search result whose stdout merely
  // contains the literal substring can no longer trigger a respawn.
  //
  // Shell-invoked runs (no UI) have no nonce env var — we emit the
  // marker with an empty `nonce=` value, which the UI parser
  // (`parse_self_update_cue_with_nonce` with empty expected nonce)
  // rejects. That is intentional: standalone-shell users were never
  // auto-respawned anyway; they read the operator banner above and
  // re-run `synapseia start` themselves.
  const nonce = process.env.SYNAPSEIA_SELF_UPDATE_NONCE ?? '';
  const version = readOwnVersion();
  const pid = process.pid;
  // eslint-disable-next-line no-console
  console.log(`[SELF_UPDATE_RESTART] nonce=${nonce} v${version} pid=${pid}`);

  // Detached self-respawn for unsupervised runs (pods / shell). The
  // desktop UI is excluded: it keeps its own child-process handle and
  // respawns on exit, so a self-spawned child would collide on the lock
  // file. We gate on the launch source here (not the caller) so a
  // mis-set `respawn` flag can never break the UI path.
  const uiSupervised = process.env.SYNAPSEIA_LAUNCH_SOURCE === 'ui';
  if (handles.respawn && !uiSupervised) {
    // Drop the lock FIRST so the child's single-instance check passes.
    if (handles.releaseLock) {
      try { handles.releaseLock(); } catch { /* best effort */ }
    }
    const spawned = respawnDetached();
    logger.log(
      spawned
        ? '[SelfUpdate] spawned detached replacement process — exiting parent.'
        : '[SelfUpdate] detached respawn unavailable — exiting; host must relaunch.',
    );
  }
  process.exit(0);
}

/**
 * Read this package's own version from the nearest `package.json`. Used
 * by `restartProcess` to embed the version into the canonical
 * `[SELF_UPDATE_RESTART]` marker so the desktop UI can log which build
 * just exited (helps diagnose stuck-on-old-version reports). Falls back
 * to `"0.0.0"` if the lookup fails — the marker still validates as
 * semver-shaped and the UI just sees an unknown version.
 */
function readOwnVersion(): string {
  try {
    const pkgPath = findOwnPackageJson(dirname(__filename));
    if (!pkgPath) return '0.0.0';
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && valid(parsed.version)) {
      return parsed.version;
    }
  } catch { /* fall through */ }
  return '0.0.0';
}

/**
 * Walk up from `start` looking for a `package.json` that names this
 * package. Bounded depth so we never wander outside the install tree.
 */
function findOwnPackageJson(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, 'utf-8');
        if (text.includes('"@synapseia-network/node"')) {
          return candidate;
        }
      } catch { /* ignore unreadable */ }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
