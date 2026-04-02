/**
 * Tool types for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  latencyMs: number;
  error?: string;
}

export interface ToolCall {
  toolName: string;
  params: Record<string, unknown>;
}

// Parsed from LLM response during ReAct
export interface ReActThought {
  thought: string;
  action: 'use_tool' | 'generate_answer';
  toolCall?: ToolCall;
  answer?: string;
}
