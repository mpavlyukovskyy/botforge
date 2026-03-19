/**
 * BotForge Gemini Brain — raw fetch() wrapper for Google Gemini API
 *
 * Used by Ashley (email classifier) and similar bots that need
 * fast, cheap classification without tool calling.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GeminiBrainConfig {
  model: string;
  apiKey: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GeminiInput {
  userMessage: string;
  contextBlocks?: string[];
}

export interface GeminiResponse {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

/**
 * Send a message to the Gemini API.
 *
 * No tool calling — pure text generation for classification/extraction.
 */
export async function askGemini(config: GeminiBrainConfig, input: GeminiInput): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;

  // Build content parts
  const parts: Array<{ text: string }> = [];

  // System prompt as first part
  if (config.systemPrompt) {
    let systemText = config.systemPrompt;
    if (input.contextBlocks?.length) {
      systemText += '\n\n' + input.contextBlocks.join('\n\n');
    }
    parts.push({ text: systemText });
  }

  parts.push({ text: input.userMessage });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: config.temperature ?? 0,
      maxOutputTokens: config.maxTokens ?? 4096,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Gemini API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    candidates?: Array<{
      content: { parts: Array<{ text: string }> };
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
    };
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usage = {
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return { text, usage };
}
