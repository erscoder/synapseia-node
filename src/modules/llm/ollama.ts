import { Injectable, Logger } from '@nestjs/common';
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
  /** Force the model to emit valid JSON via constrained decoding (Ollama format:"json") */
  forceJson?: boolean;
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
  private readonly logger = new Logger(OllamaHelper.name);

  async checkOllama(url: string = process.env.OLLAMA_URL || 'http://localhost:11434'): Promise<OllamaStatus> {
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
  async pullModel(model: string, url: string = process.env.OLLAMA_URL || 'http://localhost:11434'): Promise<void> {
    try {
      this.logger.log(`📥 Pulling model ${model} from Ollama...`);
      const ollamaClient = new Ollama({ host: url });
      const stream = await ollamaClient.pull({ model, stream: true });

      let lastDigest = '';
      for await (const part of stream) {
        if (part.digest && part.digest !== lastDigest) {
          const percent =
            part.total !== undefined && part.completed !== undefined
              ? Math.round((part.completed / part.total) * 100)
              : 0;
          this.logger.log(`📦 ${model}: ${percent}% complete`);
          lastDigest = part.digest;
        }
        if (part.status === 'success') {
          this.logger.log(`✅ Model ${model} downloaded successfully`);
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
    url: string = process.env.OLLAMA_URL || 'http://localhost:11434',
    options?: GenerateOptions,
  ): Promise<string> {
    try {
      let targetModel = model;
      if (!targetModel) {
        const status = await this.checkOllama(url);
        if (!status.available) throw new Error('Ollama is not available');
        targetModel = status.recommendedModel;
      }

      this.logger.log(`🧠 Generating with model: ${targetModel}`);
      const ollamaClient = new Ollama({ host: url });

      const response = await ollamaClient.chat({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        // format: "json" enables grammar-based constrained decoding — the model
        // is physically prevented from emitting non-JSON tokens, so JSON.parse
        // never fails due to syntax errors (no fences, no trailing text, no
        // unclosed strings). Still need to validate fields after parsing.
        ...(options?.forceJson && { format: 'json' }),
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
  async ensureModel(model: string, url: string = process.env.OLLAMA_URL || 'http://localhost:11434'): Promise<void> {
    const status = await this.checkOllama(url);

    if (!status.available) {
      throw new Error('Ollama is not running. Start with: ollama serve');
    }

    const modelAvailable = status.models.some((m) => m.startsWith(model.split(':')[0]));

    if (!modelAvailable) {
      this.logger.log(`⚠️ Model ${model} not found. Pulling...`);
      await this.pullModel(model, url);
    } else {
      this.logger.log(`✅ Model ${model} is available`);
    }
  }
}
