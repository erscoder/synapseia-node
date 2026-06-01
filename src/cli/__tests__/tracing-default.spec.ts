/**
 * Unit tests for `applyTracingDefault` — the LangChain/LangSmith
 * background-tracing default guard wired into the CLI bootstrap.
 *
 * Contract: a normal user who sets NO env vars must end up with tracing
 * OFF so the bundled `langsmith` SDK never spams 403 Forbidden. Tracing
 * activates ONLY when the operator explicitly sets LANGCHAIN_TRACING_V2
 * (or its alias LANGSMITH_TRACING) to the string 'true'.
 */
import { applyTracingDefault } from '../tracing-default';

describe('cli/tracing-default — applyTracingDefault', () => {
  it('forces both flags to "false" when neither var is set', () => {
    const env: NodeJS.ProcessEnv = {};
    applyTracingDefault(env);
    expect(env.LANGCHAIN_TRACING_V2).toBe('false');
    expect(env.LANGSMITH_TRACING).toBe('false');
  });

  it('respects an explicit LANGCHAIN_TRACING_V2="true" opt-in', () => {
    const env: NodeJS.ProcessEnv = { LANGCHAIN_TRACING_V2: 'true' };
    applyTracingDefault(env);
    expect(env.LANGCHAIN_TRACING_V2).toBe('true');
    // The alias is left untouched (still unset) — we never clobber an opt-in.
    expect(env.LANGSMITH_TRACING).toBeUndefined();
  });

  it('respects an explicit LANGSMITH_TRACING="true" opt-in (alias)', () => {
    const env: NodeJS.ProcessEnv = { LANGSMITH_TRACING: 'true' };
    applyTracingDefault(env);
    expect(env.LANGSMITH_TRACING).toBe('true');
    expect(env.LANGCHAIN_TRACING_V2).toBeUndefined();
  });

  it('forces "false" for any non-"true" value (e.g. inherited "1" or "false")', () => {
    const env: NodeJS.ProcessEnv = { LANGCHAIN_TRACING_V2: '1' };
    applyTracingDefault(env);
    expect(env.LANGCHAIN_TRACING_V2).toBe('false');
    expect(env.LANGSMITH_TRACING).toBe('false');
  });
});
