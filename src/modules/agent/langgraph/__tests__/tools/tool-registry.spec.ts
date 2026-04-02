/**
 * Tests for ToolRegistry
 * Sprint C - ReAct Tool Calling
 */

import { ToolRegistry } from '../../tools/tool-registry';
import type { ToolDef } from '../../tools/types';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  const mockTool1: ToolDef = {
    name: 'tool_one',
    description: 'First test tool',
    parameters: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'First parameter' },
      },
      required: ['param1'],
    },
  };

  const mockTool2: ToolDef = {
    name: 'tool_two',
    description: 'Second test tool',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'number', description: 'A number value' },
      },
    },
  };

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register', () => {
    it('should register a tool', () => {
      registry.register(mockTool1);

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.get('tool_one')).toEqual(mockTool1);
    });

    it('should register multiple tools', () => {
      registry.register(mockTool1);
      registry.register(mockTool2);

      expect(registry.getAll()).toHaveLength(2);
    });

    it('should overwrite existing tool with same name', () => {
      const updatedTool = { ...mockTool1, description: 'Updated description' };
      registry.register(mockTool1);
      registry.register(updatedTool);

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.get('tool_one')?.description).toBe('Updated description');
    });
  });

  describe('get', () => {
    it('should return tool by name', () => {
      registry.register(mockTool1);

      const tool = registry.get('tool_one');

      expect(tool).toEqual(mockTool1);
    });

    it('should return undefined for non-existent tool', () => {
      const tool = registry.get('non_existent');

      expect(tool).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return empty array when no tools registered', () => {
      const tools = registry.getAll();

      expect(tools).toEqual([]);
    });

    it('should return all registered tools', () => {
      registry.register(mockTool1);
      registry.register(mockTool2);

      const tools = registry.getAll();

      expect(tools).toHaveLength(2);
      expect(tools).toContainEqual(mockTool1);
      expect(tools).toContainEqual(mockTool2);
    });
  });

  describe('toPromptString', () => {
    it('should return empty string when no tools registered', () => {
      const prompt = registry.toPromptString();

      expect(prompt).toBe('');
    });

    it('should format single tool correctly', () => {
      registry.register(mockTool1);

      const prompt = registry.toPromptString();

      expect(prompt).toBe('- tool_one: First test tool');
    });

    it('should format multiple tools with newlines', () => {
      registry.register(mockTool1);
      registry.register(mockTool2);

      const prompt = registry.toPromptString();

      expect(prompt).toBe('- tool_one: First test tool\n- tool_two: Second test tool');
    });

    it('should include all tool descriptions', () => {
      registry.register(mockTool1);
      registry.register(mockTool2);

      const prompt = registry.toPromptString();

      expect(prompt).toContain('First test tool');
      expect(prompt).toContain('Second test tool');
      expect(prompt).toContain('tool_one');
      expect(prompt).toContain('tool_two');
    });
  });
});
