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
 * Returns the check result (caller decides whether to self-update or abort).
 */
export async function preflightVersionCheck(coordinatorUrl: string): Promise<UpdateCheckResult | null> {
  const info = await fetchVersionInfo(coordinatorUrl);
  if (!info) {
    logger.warn('[UpdateCheck] Could not reach coordinator /version — skipping pre-flight check');
    return null;
  }

  const result = checkVersion(getNodeVersion(), info);

  switch (result.status) {
    case UpdateStatus.UP_TO_DATE:
      logger.log(`[UpdateCheck] v${result.currentVersion} is up to date`);
      break;
    case UpdateStatus.UPDATE_AVAILABLE:
      logger.warn(
        `[UpdateCheck] Update available: v${result.currentVersion} -> v${result.latestVersion}`,
      );
      break;
    case UpdateStatus.UPDATE_REQUIRED:
      logger.error(
        `[UpdateCheck] Update REQUIRED: v${result.currentVersion} < minimum v${result.minVersion}. ` +
          `Latest: v${result.latestVersion}`,
      );
      break;
  }

  return result;
}
