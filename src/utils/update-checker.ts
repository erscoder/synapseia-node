import { lt, valid } from 'semver';
import logger from './logger';
import { getNodeVersion } from './version';

export interface VersionInfo {
  protocolVersion: number;
  minNodeVersion: string;
  latestNodeVersion: string;
  latestNodeUiVersion: string;
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
 */
export async function fetchVersionInfo(coordinatorUrl: string): Promise<VersionInfo | null> {
  try {
    const resp = await fetch(`${coordinatorUrl}/version`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    return (await resp.json()) as VersionInfo;
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
 * Compare local node version against coordinator requirements.
 */
export function checkVersion(local: string, info: VersionInfo): UpdateCheckResult {
  const current = valid(local) ?? '0.0.0';
  const min = valid(info.minNodeVersion) ?? '0.0.0';
  const latest = valid(info.latestNodeVersion) ?? current;

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
 * Latest version comes from the npm registry (canonical source for node-only
 * releases — no coord redeploy required to publish). Falls back to coord
 * `/version` when npm is unreachable. The security floor `minNodeVersion`
 * ALWAYS comes from coord — npm is never trusted for the pin.
 *
 * Returns the check result (caller decides whether to self-update or abort).
 */
export async function preflightVersionCheck(coordinatorUrl: string): Promise<UpdateCheckResult | null> {
  const [npmLatest, coordInfo] = await Promise.all([fetchNpmLatest(), fetchVersionInfo(coordinatorUrl)]);

  let latestVersion: string | null = null;
  let latestSource: 'npm' | 'coord' | null = null;
  if (npmLatest) {
    latestVersion = npmLatest;
    latestSource = 'npm';
  } else if (coordInfo?.latestNodeVersion) {
    latestVersion = coordInfo.latestNodeVersion;
    latestSource = 'coord';
  }

  if (!latestVersion) {
    logger.warn('[UpdateCheck] Could not reach npm registry or coordinator /version — skipping pre-flight check');
    return null;
  }

  const minVersion = coordInfo?.minNodeVersion ?? '0.0.0';
  const mergedInfo: VersionInfo = {
    protocolVersion: coordInfo?.protocolVersion ?? 0,
    minNodeVersion: minVersion,
    latestNodeVersion: latestVersion,
    latestNodeUiVersion: coordInfo?.latestNodeUiVersion ?? '',
  };

  const result = checkVersion(getNodeVersion(), mergedInfo);

  switch (result.status) {
    case UpdateStatus.UP_TO_DATE:
      logger.log(`[UpdateCheck] v${result.currentVersion} is up to date (latest from ${latestSource})`);
      break;
    case UpdateStatus.UPDATE_AVAILABLE:
      logger.warn(
        `[UpdateCheck] Update available: v${result.currentVersion} -> v${result.latestVersion} (latest from ${latestSource})`,
      );
      break;
    case UpdateStatus.UPDATE_REQUIRED:
      logger.error(
        `[UpdateCheck] Update REQUIRED: v${result.currentVersion} < minimum v${result.minVersion}. ` +
          `Latest: v${result.latestVersion} (from ${latestSource})`,
      );
      break;
  }

  return result;
}
