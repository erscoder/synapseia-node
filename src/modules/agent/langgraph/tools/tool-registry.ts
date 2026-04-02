/**
 * Tool Registry for ReAct pattern
 * Sprint C - ReAct Tool Calling
 */

import { Injectable } from '@nestjs/common';
import type { ToolDef } from './types';

@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  // Returns the JSON schema description for the LLM prompt
  toPromptString(): string {
    return this.getAll()
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');
  }
}
