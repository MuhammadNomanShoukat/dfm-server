import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

export async function ollamaChat(system: string, user: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OLLAMA_MODEL,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content?.trim() || 'No response from the local model.';
  } catch (error) {
    logger.warn('ollama_unavailable', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
