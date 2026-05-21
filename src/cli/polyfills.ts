/**
 * Runtime polyfills — MUST execute before any other module in the process.
 *
 * `bootstrap.ts` imports this file FIRST (before its other static imports and
 * before the dynamic `import('./index.js')` that pulls in the libp2p graph).
 * ES module side-effect imports run in source order at parse time, so placing
 * this as bootstrap's first import guarantees these patches are installed
 * before any dependency's module-level code runs.
 *
 * `Promise.withResolvers`:
 *   Standardized in Node 22. Absent in Node 20 (which the package's
 *   `engines.node` still targets). A libp2p transitive dependency calls
 *   `Promise.withResolvers()` at module-load time; without this polyfill the
 *   call throws `Promise.withResolvers is not a function`, P2P/gossipsub init
 *   fails, and the node silently degrades to HTTP-only on every Node-20
 *   operator. The polyfill is spec-correct and only defined when missing, so
 *   on Node 22+ the native implementation is left untouched.
 */

if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function') {
    (
        Promise as unknown as {
            withResolvers: <T>() => {
                promise: Promise<T>;
                resolve: (value: T | PromiseLike<T>) => void;
                reject: (reason?: unknown) => void;
            };
        }
    ).withResolvers = function withResolvers<T>() {
        let resolve!: (value: T | PromiseLike<T>) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}

// Marks this as an ES module so Node/tsup treat it consistently with the
// other `dist/cli/*.js` sibling files emitted under `bundle: false`.
export {};
