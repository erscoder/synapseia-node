/**
 * Unit tests for the runtime polyfills installed by `bootstrap.ts`.
 *
 * The key behaviour: on Node 20 (no native `Promise.withResolvers`) the
 * polyfill must install a spec-correct implementation so the libp2p
 * transitive dep that calls it at module-load time does not throw
 * `Promise.withResolvers is not a function`. On Node 22+ the native
 * implementation must be left untouched.
 */

type WithResolvers = {
    withResolvers?: <T>() => {
        promise: Promise<T>;
        resolve: (value: T | PromiseLike<T>) => void;
        reject: (reason?: unknown) => void;
    };
};

const PromiseWR = Promise as unknown as WithResolvers;

describe('cli/polyfills — Promise.withResolvers', () => {
    let original: WithResolvers['withResolvers'];

    beforeEach(() => {
        original = PromiseWR.withResolvers;
    });

    afterEach(() => {
        // Restore whatever was there before (native impl or undefined) so we
        // never leak a polyfilled global across the rest of the suite.
        if (original === undefined) {
            delete PromiseWR.withResolvers;
        } else {
            PromiseWR.withResolvers = original;
        }
        jest.resetModules();
    });

    it('installs the polyfill when missing (simulating Node 20)', async () => {
        // Simulate Node 20: no native implementation present.
        delete PromiseWR.withResolvers;
        expect(typeof PromiseWR.withResolvers).toBe('undefined');

        await import('../polyfills.js');

        expect(typeof PromiseWR.withResolvers).toBe('function');
    });

    it('does NOT overwrite a native implementation when present', async () => {
        const native = jest.fn();
        PromiseWR.withResolvers = native as unknown as WithResolvers['withResolvers'];

        await import('../polyfills.js');

        expect(PromiseWR.withResolvers).toBe(native);
    });

    it('resolves via the returned deferred resolve()', async () => {
        delete PromiseWR.withResolvers;
        await import('../polyfills.js');

        const { promise, resolve } = PromiseWR.withResolvers!<string>();
        resolve('ok');

        await expect(promise).resolves.toBe('ok');
    });

    it('rejects via the returned deferred reject()', async () => {
        delete PromiseWR.withResolvers;
        await import('../polyfills.js');

        const { promise, reject } = PromiseWR.withResolvers!<never>();
        const err = new Error('boom');
        reject(err);

        await expect(promise).rejects.toBe(err);
    });

    it('returns independent deferreds on each call', async () => {
        delete PromiseWR.withResolvers;
        await import('../polyfills.js');

        const a = PromiseWR.withResolvers!<number>();
        const b = PromiseWR.withResolvers!<number>();

        a.resolve(1);
        b.resolve(2);

        await expect(a.promise).resolves.toBe(1);
        await expect(b.promise).resolves.toBe(2);
    });
});
