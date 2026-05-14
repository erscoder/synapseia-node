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
 */

const BIGINT_PREFIX = 'bigint: Failed to load bindings';
const BIGINT_LINE_FRAGMENT = 'bigint: Failed to load bindings, pure JS will be used';

/**
 * Wrap `console.warn` so any call whose first arg starts with the
 * `bigint-buffer` failure prefix is silently dropped. Every other warning
 * passes through untouched. Calling this more than once compounds the
 * wrappers — that is intentionally cheap and acceptable.
 */
export function muteBigintBindingConsoleWarn(): void {
    const original = console.warn.bind(console);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    console.warn = function patched(...args: any[]): void {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith(BIGINT_PREFIX)) {
            return;
        }
        return original(...args);
    } as typeof console.warn;
}

/**
 * Wrap `process.stderr.write` so any chunk containing the `bigint-buffer`
 * failure line is silently dropped. Every other write passes through.
 */
export function muteBigintBindingStderrWrite(): void {
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = function patched(chunk: any, ...rest: any[]): boolean {
        const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
        if (s.includes(BIGINT_LINE_FRAGMENT)) {
            return true;
        }
        return (originalWrite as any)(chunk, ...rest);
    } as typeof process.stderr.write;
}
