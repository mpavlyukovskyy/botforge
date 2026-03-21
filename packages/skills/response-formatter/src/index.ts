import type { Skill, SkillContext, PlatformAdapter, Logger } from '@botforge/core';

interface ResponseConfig {
  typing_indicator: boolean;
  markdown: boolean;
  markdown_fallback: boolean;
  max_message_length: number;
  disable_link_preview: boolean;
}

const DEFAULTS: ResponseConfig = {
  typing_indicator: true,
  markdown: true,
  markdown_fallback: true,
  max_message_length: 4096,
  disable_link_preview: false,
};

/**
 * Chunks text at sentence boundaries, respecting max length.
 */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at sentence boundary
    const slice = remaining.slice(0, maxLen);
    let breakIdx = -1;

    // Prefer sentence endings
    for (const sep of ['. ', '! ', '? ', '\n\n', '\n']) {
      const idx = slice.lastIndexOf(sep);
      if (idx > maxLen * 0.3) {
        breakIdx = idx + sep.length;
        break;
      }
    }

    // Fallback to word boundary
    if (breakIdx === -1) {
      breakIdx = slice.lastIndexOf(' ');
      if (breakIdx < maxLen * 0.3) breakIdx = maxLen;
    }

    chunks.push(remaining.slice(0, breakIdx).trimEnd());
    remaining = remaining.slice(breakIdx).trimStart();
  }

  return chunks;
}

export class ResponseFormatterSkill implements Skill {
  readonly name = 'response-formatter';
  private config: ResponseConfig = DEFAULTS;
  private adapter!: PlatformAdapter;
  private log!: Logger;

  async init(ctx: SkillContext): Promise<void> {
    this.adapter = ctx.adapter;
    this.log = ctx.log;

    const responseCfg = (ctx.config as any).behavior?.response;
    if (responseCfg) {
      this.config = { ...DEFAULTS, ...responseCfg };
    }

    ctx.log.info(`Response formatter: markdown=${this.config.markdown}, typing=${this.config.typing_indicator}, maxLen=${this.config.max_message_length}`);
  }

  /** Send typing indicator if configured and adapter supports it */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.config.typing_indicator) return;
    if (this.adapter.sendChatAction) {
      try {
        await this.adapter.sendChatAction(chatId, 'typing');
      } catch {
        // Graceful degrade — typing indicators are best-effort
      }
    }
  }

  /** Format and send a response, handling chunking, markdown, and fallback */
  async formatAndSend(chatId: string, text: string): Promise<void> {
    if (!text) return;

    const chunks = chunkText(text, this.config.max_message_length);

    for (const chunk of chunks) {
      const parseMode = this.config.markdown ? 'Markdown' as const : undefined;

      try {
        await this.adapter.send({
          chatId,
          text: chunk,
          parseMode,
          disablePreview: this.config.disable_link_preview || undefined,
        });
      } catch (err) {
        // If markdown parse error and fallback enabled, retry without parseMode
        if (this.config.markdown && this.config.markdown_fallback && isMarkdownError(err)) {
          this.log.debug(`Markdown parse failed, retrying as plain text`);
          try {
            await this.adapter.send({
              chatId,
              text: chunk,
              disablePreview: this.config.disable_link_preview || undefined,
            });
          } catch (retryErr) {
            this.log.error(`Failed to send message even as plain text: ${retryErr}`);
            throw retryErr;
          }
        } else {
          throw err;
        }
      }
    }
  }
}

function isMarkdownError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes('parse') || msg.includes('markdown') || msg.includes('can\'t parse');
}

export function createSkill(): ResponseFormatterSkill {
  return new ResponseFormatterSkill();
}

export default new ResponseFormatterSkill();
