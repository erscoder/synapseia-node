import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { Ollama } from 'ollama';

/**
 * Ollama integration module for Synapseia nodes
 * Handles health checks, model pulling, and generation
 */

export interface OllamaStatus {
  available: boolean;
  url: string;
  models: string[];
  recommendedModel: string;
  error?: string;
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Injectable service for Ollama integration.
 * Provides health checks, model management, and text generation.
 */
@Injectable()
export class OllamaHelper {
  /**
   * Check Ollama availability and installed models
   */
  async checkOllama(url: string = 'http://localhost:11434'): Promise<OllamaStatus> {
    try {
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      const models: string[] = response.data.models.map((m: any) => m.name);

      // Detect hardware to recommend appropriate model (dynamic import to avoid circular deps)
      const { HardwareHelper } = await import('../hardware/hardware.js');
      const hwInfo = new HardwareHelper().detectHardware(false);
      const hasGPU = hwInfo.gpuVramGb > 0;

      const recommendedModel = hasGPU ? 'qwen2.5:3b' : 'qwen2.5:0.5b';

      return { available: true, url, models, recommendedModel };
    } catch (error) {
      const isAxiosError = error && typeof error === 'object' && 'isAxiosError' in error;
      if (isAxiosError) {
        return {
          available: false,
          url,
          models: [],
          recommendedModel: 'qwen2.5:0.5b',
          error: `Cannot connect to Ollama at ${url}: ${(error as any).message}`,
        };
      }

      let errorMessage = 'Unknown error';
      if (error instanceof Error) errorMessage = error.message;

      return { available: false, url, models: [], recommendedModel: 'qwen2.5:0.5b', error: errorMessage };
    }
  }

  /**
   * Pull a model from Ollama registry
   */
  async pullModel(model: string, url: string = 'http://localhost:11434'): Promise<void> {
    try {
      console.log(`📥 Pulling model ${model} from Ollama...`);
      const ollamaClient = new Ollama({ host: url });
      const stream = await ollamaClient.pull({ model, stream: true });

      let lastDigest = '';
      for await (const part of stream) {
        if (part.digest && part.digest !== lastDigest) {
          const percent =
            part.total !== undefined && part.completed !== undefined
              ? Math.round((part.completed / part.total) * 100)
              : 0;
          console.log(`📦 ${model}: ${percent}% complete`);
          lastDigest = part.digest;
        }
        if (part.status === 'success') {
          console.log(`✅ Model ${model} downloaded successfully`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to pull model ${model}: ${errorMessage}`);
    }
  }

  /**
   * Generate text using Ollama
   */
  async generate(
    prompt: string,
    model?: string,
    url: string = 'http://localhost:11434',
    options?: GenerateOptions,
  ): Promise<string> {
    try {
      let targetModel = model;
      if (!targetModel) {
        const status = await this.checkOllama(url);
        if (!status.available) throw new Error('Ollama is not available');
        targetModel = status.recommendedModel;
      }

      console.log(`🧠 Generating with model: ${targetModel}`);
      const ollamaClient = new Ollama({ host: url });

      const response = await ollamaClient.chat({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: {
          ...(options?.temperature !== undefined && { temperature: options.temperature }),
          ...(options?.maxTokens !== undefined && { num_predict: options.maxTokens }),
          ...(options?.topP !== undefined && { top_p: options.topP }),
        },
      });

      return response.message.content.trim();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Generation failed: ${errorMessage}`);
    }
  }

  /**
   * Ensure a model is available, pulling if necessary
   */
  async ensureModel(model: string, url: string = 'http://localhost:11434'): Promise<void> {
    const status = await this.checkOllama(url);

    if (!status.available) {
      throw new Error('Ollama is not running. Start with: ollama serve');
    }

    const modelAvailable = status.models.some((m) => m.startsWith(model.split(':')[0]));

    if (!modelAvailable) {
      console.log(`⚠️ Model ${model} not found. Pulling...`);
      await this.pullModel(model, url);
    } else {
      console.log(`✅ Model ${model} is available`);
    }
  }
}
