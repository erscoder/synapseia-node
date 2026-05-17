import { lt, valid } from 'semver';
import logger from './logger';
import { getNodeVersion } from './version';

/**
 * Subset of fields the coordinator's `GET /version` endpoint exposes
 * that the node still trusts.
 *
 * 2026-05-17: the legacy `latestNodeVersion` / `latestNodeUiVersion`
 * fields were intentionally dropped from this contract. Coord-baked
 * `LATEST_VERSION` got stale every time we shipped a node-only release
 * without redeploying coord (live bug on 2026-05-17: coord 0.8.67
 * reported `latestNodeVersion: "0.8.67"` while npm already had 0.8.76,
 * so any node that fell back to coord risked downgrading itself).
 *
 * Source of truth split:
 *   - `latestNodeVersion`  → npm registry (`fetchNpmLatest`). npm cannot
 *                            be replaced by coord here: a node-only
 *                            release is exactly the case where coord
 *                            hasn't been redeployed.
 *   - `minNodeVersion`     → coord (this interface). Security floor
 *                            that npm cannot serve.
 *   - `protocolVersion`    → coord (this interface).
 */
export interface VersionInfo {
  protocolVersion: number;
  minNodeVersion: string;
}

export enum UpdateStatus {
  UP_TO_DATE = 'up_to_date',
  UPDATE_AVAILABLE = 'update_available',
  UPDATE_REQUIRED = 'update_required',
}

export interface UpdateCheckResult {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string;
  minVersion: string;
}

const NODE_PACKAGE_NAME = '@synapseia-network/node';
const NODE_PACKAGE_NAME_ENCODED = NODE_PACKAGE_NAME.replace('/', '%2F');
const NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${NODE_PACKAGE_NAME_ENCODED}/dist-tags`;

/**
 * Fetch version info from the coordinator's GET /version endpoint.
 *
 * Only `protocolVersion` and `minNodeVersion` are consumed — any extra
 * fields coord still returns for legacy compatibility are ignored.
 */
export async function fetchVersionInfo(coordinatorUrl: string): Promise<VersionInfo | null> {
  try {
    const resp = await fetch(`${coordinatorUrl}/version`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const raw = (await resp.json()) as Partial<VersionInfo>;
    if (typeof raw?.protocolVersion !== 'number' || typeof raw?.minNodeVersion !== 'string') {
      return null;
    }
    return { protocolVersion: raw.protocolVersion, minNodeVersion: raw.minNodeVersion };
  } catch {
    return null;
  }
}

/**
 * Fetch the `latest` dist-tag for the node CLI directly from the npm registry.
 * Returns the version string on success, or null on any failure (network,
 * non-2xx, malformed body, missing `latest`).
 */
export async function fetchNpmLatest(): Promise<string | null> {
  try {
    const resp = await fetch(NPM_DIST_TAGS_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { latest?: unknown };
    if (typeof body?.latest !== 'string' || !valid(body.latest)) return null;
    return body.latest;
  } catch {
    return null;
  }
}

/**
 * Compare local node version against the security floor (from coord) and
 * the latest published version (from npm).
 *
 * `latestNodeVersion` is passed as a separate argument because its
 * source (npm) differs from `info`'s source (coord). When npm is
 * unreachable, callers should NOT invoke `checkVersion` — they should
 * skip the pre-flight check entirely (no coord fallback exists by
 * design — see VersionInfo docblock).
 */
export function checkVersion(
  local: string,
  info: VersionInfo,
  latestNodeVersion: string,
): UpdateCheckResult {
  const current = valid(local) ?? '0.0.0';
  const min = valid(info.minNodeVersion) ?? '0.0.0';
  const latest = valid(latestNodeVersion) ?? current;

  if (lt(current, min)) {
    return { status: UpdateStatus.UPDATE_REQUIRED, currentVersion: current, latestVersion: latest, minVersion: min };
  }
  if (lt(current, latest)) {
    return { status: UpdateStatus.UPDATE_AVAILABLE, currentVersion: current, latestVersion: latest, minVersion: min };
  }
  return { status: UpdateStatus.UP_TO_DATE, currentVersion: current, latestVersion: latest, minVersion: min };
}

/**
 * Pre-flight version check. Called before connecting to the coordinator.
 *
 * `latestNodeVersion` comes EXCLUSIVELY from the npm registry — coord
 * is no longer consulted as a fallback (see VersionInfo docblock for
 * the 2026-05-17 decoupling rationale). If npm is unreachable, the
 * pre-flight check is skipped (returns null + WARN); the security
 * floor `minNodeVersion` still comes from coord, but the update-status
 * decision is deferred to the next attempt rather than risking a stale
 * coord-baked value triggering a downgrade.
 *
 * Returns the check result (caller decides whether to self-update or abort).
 */
export async function preflightVersionCheck(coordinatorUrl: string): Promise<UpdateCheckResult | null> {
  const [npmLatest, coordInfo] = await Promise.all([fetchNpmLatest(), fetchVersionInfo(coordinatorUrl)]);

  if (!npmLatest) {
    logger.warn(
      '[UpdateCheck] npm registry unreachable — skipping pre-flight check ' +
        '(coord is not consulted as a fallback for latestNodeVersion; ' +
        'see update-checker.ts docblock).',
    );
    return null;
  }

  const minVersion = coordInfo?.minNodeVersion ?? '0.0.0';
  const protocolVersion = coordInfo?.protocolVersion ?? 0;

  const result = checkVersion(
    getNodeVersion(),
    { protocolVersion, minNodeVersion: minVersion },
    npmLatest,
  );

  switch (result.status) {
    case UpdateStatus.UP_TO_DATE:
      logger.log(`[UpdateCheck] v${result.currentVersion} is up to date (latest from npm)`);
      break;
    case UpdateStatus.UPDATE_AVAILABLE:
      logger.warn(
        `[UpdateCheck] Update available: v${result.currentVersion} -> v${result.latestVersion} (latest from npm)`,
      );
      break;
    case UpdateStatus.UPDATE_REQUIRED:
      logger.error(
        `[UpdateCheck] Update REQUIRED: v${result.currentVersion} < minimum v${result.minVersion}. ` +
          `Latest: v${result.latestVersion} (from npm)`,
      );
      break;
  }

  return result;
}
