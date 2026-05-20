/**
 * Filter helpers for the `bigint-buffer` "Failed to load bindings, pure JS
 * will be used" warning. This warning is emitted by `bigint-buffer` (a
 * transitive dep of @solana/web3.js) at module-load time on machines whose
 * native binding cannot be loaded — typically Windows installs without a
 * C++ toolchain. The pure-JS fallback is correct; the message only adds
 * noise above the wallet password prompt and used to leak into the
 * desktop SettingsPanel toast.
 *
 * Two layers of filtering are applied from `bootstrap.ts`:
 *   1. `muteBigintBindingConsoleWarn` — overrides `console.warn` at the
 *      API surface BEFORE bigint-buffer (or any transitive dep) loads.
 *   2. `muteBigintBindingStderrWrite` — patches `process.stderr.write` as
 *      defense in depth. On Windows when stderr is a pipe rather than a
 *      TTY, Node may take an internal write path that bypasses the
 *      `process.stderr.write` override, so layer 1 catches the warning
 *      at its source.
 *
 * Both functions are extracted into their own module so they can be unit
 * tested without triggering the `import('./index.js')` side effect that
 * `bootstrap.ts` performs at load time.
 *
 * F-node-018 (LOW): @solana/web3.js >=1.95 dropped the direct `bigint-buffer`
 * dep so this filter is likely obsolete for our supported `^1.98` range on
 * Linux+macOS+Windows w/ Node 20+. Rather than blindly delete without a
 * cross-platform probe (we have no CI for that here), this module now:
 *   - exits early when `SYNAPSEIA_DISABLE_BIGINT_FILTER=true` (operator
 *     escape hatch so we can A/B against the filter in prod).
 *   - emits a one-time stderr telemetry line `[bigint-filter] triggered` on
 *     the FIRST actual match (console.warn or stderr.write). If we never
 *     see that line across the fleet for a release cycle, this module +
 *     `bootstrap.ts` invocation + spec can be deleted in a follow-up.
 *   - The disable check is read once at function entry to avoid env-var
 *     re-lookup per write call.
 *
 * @deprecated Pending fleet-wide telemetry confirmation. Track via the
 *   `[bigint-filter] triggered` log line; delete once unobserved.
 */

const BIGINT_PREFIX = 'bigint: Failed to load bindings';
const BIGINT_LINE_FRAGMENT = 'bigint: Failed to load bindings, pure JS will be used';
const DISABLE_ENV = 'SYNAPSEIA_DISABLE_BIGINT_FILTER';

/** Process-scoped one-shot so we don't spam stderr if the warning ever fires repeatedly. */
let triggeredOnce = false;
function noteTriggered(source: 'console.warn' | 'stderr.write'): void {
    if (triggeredOnce) return;
    triggeredOnce = true;
    // Bypass our own stderr filter by using the bound original via fd write.
    try {
        process.stderr.write(`[bigint-filter] triggered source=${source} — module still useful on this platform\n`);
    } catch { /* swallow — telemetry must never crash bootstrap */ }
}

/**
 * Wrap `console.warn` so any call whose first arg starts with the
 * `bigint-buffer` failure prefix is silently dropped. Every other warning
 * passes through untouched. Calling this more than once compounds the
 * wrappers — that is intentionally cheap and acceptable.
 *
 * No-op when `SYNAPSEIA_DISABLE_BIGINT_FILTER=true`.
 */
export function muteBigintBindingConsoleWarn(): void {
    if (process.env[DISABLE_ENV] === 'true') return;
    const original = console.warn.bind(console);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.warn = function patched(...args: any[]): void {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith(BIGINT_PREFIX)) {
            noteTriggered('console.warn');
            return;
        }
        return original(...args);
    } as typeof console.warn;
}

/**
 * Wrap `process.stderr.write` so any chunk containing the `bigint-buffer`
 * failure line is silently dropped. Every other write passes through.
 *
 * No-op when `SYNAPSEIA_DISABLE_BIGINT_FILTER=true`.
 */
export function muteBigintBindingStderrWrite(): void {
    if (process.env[DISABLE_ENV] === 'true') return;
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = function patched(chunk: any, ...rest: any[]): boolean {
        const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
        if (s.includes(BIGINT_LINE_FRAGMENT)) {
            noteTriggered('stderr.write');
            return true;
        }
        return (originalWrite as any)(chunk, ...rest);
    } as typeof process.stderr.write;
}
