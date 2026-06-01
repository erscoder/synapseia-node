/**
 * LangChain / LangSmith background-tracing default guard.
 *
 * The node does NOT use LangSmith. The bundled `langsmith` SDK (a
 * transitive dep of LangGraph / LangChain) reads `LANGCHAIN_TRACING_V2`
 * (and its newer alias `LANGSMITH_TRACING`) lazily, when LangGraph runs.
 * If a stray default-on value is inherited from the environment, the SDK
 * tries to upload traces with no LangSmith API key and spams
 * "Failed to send multipart request. Received status [403]: Forbidden".
 *
 * This helper force-sets BOTH flags to 'false' UNLESS the operator has
 * explicitly opted in by setting either to the string 'true' (from a real
 * env var or from a just-loaded `.env`). Pure + side-effect-scoped to the
 * passed `env` object so it is trivially unit-testable.
 */
export function applyTracingDefault(env: NodeJS.ProcessEnv): void {
  if (env.LANGCHAIN_TRACING_V2 !== 'true' && env.LANGSMITH_TRACING !== 'true') {
    env.LANGCHAIN_TRACING_V2 = 'false';
    env.LANGSMITH_TRACING = 'false';
  }
}
