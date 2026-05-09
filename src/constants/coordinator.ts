/**
 * Single source of truth for the official Synapseia coordinator URL.
 *
 * The coordinator URL is no longer user-configurable through the CLI
 * (`--coordinator`, `--set-coordinator-url`, interactive prompt) or
 * the desktop UI. Operators that need to point a node at a non-default
 * coordinator must set the `COORDINATOR_URL` / `COORDINATOR_WS_URL`
 * environment variables before launch.
 *
 * Any legacy `coordinatorUrl` value persisted in `~/.synapseia/config.json`
 * is tolerated by the schema for back-compat (so existing configs still
 * parse) but its value is ignored at runtime — always go through
 * `getCoordinatorUrl()` / `getCoordinatorWsUrl()`.
 */
export const OFFICIAL_COORDINATOR_URL = 'https://api.synapseia.network';
export const OFFICIAL_COORDINATOR_WS_URL = 'https://ws.synapseia.network';

export function getCoordinatorUrl(): string {
  const v = process.env.COORDINATOR_URL?.trim();
  return v && v.length > 0 ? v : OFFICIAL_COORDINATOR_URL;
}

export function getCoordinatorWsUrl(): string {
  const v = process.env.COORDINATOR_WS_URL?.trim();
  return v && v.length > 0 ? v : OFFICIAL_COORDINATOR_WS_URL;
}
