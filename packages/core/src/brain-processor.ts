/**
 * Brain message processor — the LLM-driven message-handler factory.
 *
 * Extracted from runtime.ts during T1.4. Behavior preserved verbatim,
 * including the 16 `(skill as any).method(...)` duck-typing calls (these
 * are the framework's loose contract with skills; renaming any of them
 * silently breaks the corresponding skill).
 *
 * Pipeline:
 *   1. Pre-brain media download (if message has a file)
 *   2. Build ToolContext + collect context blocks (from skills + bot dir)
 *   3. Inject conversation history (respecting timeout)
 *   4. Pre-parse document attachments via read_document tool
 *   5. Brain call (claude / claude-cli / gemini) with 120s timeout
 *   6. Send response via response-formatter
 *   7. Post-response inline-keyboard edit from store.postResponse
 *   8. Append to history + recordQuestion + recordUsage
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BotConfig } from './schema.js';
import type { IncomingMessage } from './adapter.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';
import type { ModuleContext } from './command-registry.js';
import { askBrain, type BrainResponse } from './brain.js';
import { askBrainCli } from './brain-cli.js';
import { askGemini } from './brain-gemini.js';
import { storeAccess } from './bot-store.js';
import type { BotInstance, MessageProcessor } from './runtime.js';
import { classifyError, renderError, shortRef, maybeNotifyAdmin } from './error-messages.js';

/**
 * Load system prompt — inline string > file > default fallback.
 */
export function loadSystemPrompt(config: BotConfig, configDir: string): string {
  if (config.brain.system_prompt) {
    return config.brain.system_prompt;
  }

  if (config.brain.system_prompt_file) {
    const promptPath = resolve(configDir, config.brain.system_prompt_file);
    if (existsSync(promptPath)) {
      return readFileSync(promptPath, 'utf-8');
    }
    throw new Error(`System prompt file not found: ${promptPath}`);
  }

  return `You are ${config.name}, an AI assistant. Be helpful and concise.`;
}

/**
 * Build a ModuleContext for hooks/handlers that need per-message scope.
 */
export function buildModuleContext(
  message: IncomingMessage,
  instance: BotInstance,
): ModuleContext {
  return {
    chatId: message.chatId,
    userId: message.userId,
    userName: message.userName,
    db: instance.db,
    config: instance.config,
    adapter: instance.adapter,
    log: instance.log,
    store: instance.store,
  };
}

const BRAIN_TIMEOUT_MS = 120_000; // 2 minutes

export function createBrainProcessor(
  config: BotConfig,
  systemPrompt: string,
  toolRegistry: ToolRegistry,
  instance: BotInstance,
): MessageProcessor {
  const { log, db } = instance;

  return async (message: IncomingMessage, inst: BotInstance) => {
    // Allow media messages with captions through (text is the caption)
    if (!message.text && !message.file) {
      log.debug(`Non-text message type "${message.type}" passed type filter; media handling not yet implemented`);
      return;
    }

    // Pre-brain media download
    let files: Buffer[] | undefined;
    let fileMetadata: ToolContext['fileMetadata'];
    if (message.file?.fileId && inst.adapter.downloadFile) {
      try {
        const buffer = await inst.adapter.downloadFile(message.file.fileId);
        files = [buffer];
        fileMetadata = [{
          fileName: message.file.fileName,
          mimeType: message.file.mimeType,
          fileSize: message.file.fileSize,
        }];
      } catch (err) {
        log.warn(`Failed to download file ${message.file.fileId}: ${err}`);
      }
    }

    log.info(`Brain: type=${message.type} file=${!!message.file} downloaded=${files?.length ?? 0}`);

    // Build tool context for this message
    const toolCtx: ToolContext = {
      chatId: message.chatId,
      userId: message.userId,
      userName: message.userName,
      db,
      config: inst.config,
      adapter: inst.adapter,
      log,
      store: inst.store,
      files,
      fileMetadata,
    };

    const brainTools = toolRegistry.toBrainTools(toolCtx);

    // Collect context blocks from context-builder skill if available
    const contextBlocks: string[] = [];
    const contextBuilder = inst.skills.get('context-builder');
    if (contextBuilder && 'getContextBlocks' in contextBuilder) {
      const blocks = await (contextBuilder as any).getContextBlocks(message.chatId);
      if (Array.isArray(blocks)) {
        contextBlocks.push(...blocks);
      }
    }

    // Inject bot-directory context builders
    if (inst.contextBuilders.length > 0) {
      const moduleCtx = buildModuleContext(message, inst);
      for (const cb of inst.contextBuilders) {
        try {
          const block = await cb.build(moduleCtx);
          if (block) contextBlocks.push(block);
        } catch (err) {
          log.warn(`Context builder "${cb.type}" failed: ${err}`);
        }
      }
    }

    // Reply context injection
    const replyCtxSkill = inst.skills.get('reply-context');
    if (replyCtxSkill && 'getContextBlock' in replyCtxSkill) {
      const replyBlock = (replyCtxSkill as any).getContextBlock(message);
      if (replyBlock) contextBlocks.push(replyBlock);
    }

    // Pending questions context injection
    const pendingQSkill = inst.skills.get('pending-questions');
    if (pendingQSkill && 'getContextBlock' in pendingQSkill) {
      const pendingBlock = (pendingQSkill as any).getContextBlock(message.chatId);
      if (pendingBlock) contextBlocks.push(pendingBlock);
    }

    // Get conversation history from conversation-history skill
    let conversationHistory: string | undefined;
    const historySkill = inst.skills.get('conversation-history');
    if (historySkill && 'formatHistory' in historySkill) {
      // Check conversation timeout
      const timeout = config.behavior?.reception?.conversation_timeout_min;
      if (timeout && timeout > 0 && 'getLastMessageTime' in historySkill) {
        const lastTime = (historySkill as any).getLastMessageTime(message.chatId);
        if (lastTime && (Date.now() - lastTime.getTime()) > timeout * 60 * 1000) {
          log.info(`Conversation timeout: ${timeout}min idle, starting fresh for ${message.chatId}`);
          // Skip history injection
        } else {
          conversationHistory = await (historySkill as any).formatHistory(message.chatId);
        }
      } else {
        conversationHistory = await (historySkill as any).formatHistory(message.chatId);
      }
    }

    let responseText: string;
    let brainResponse: BrainResponse | undefined;

    // Clear any previous post-response actions
    storeAccess.clearPostResponse(inst.store);

    // Budget gate — refuse calls past brain.budget_usd_per_day.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const budgetCap = (config.brain as any).budget_usd_per_day as number | undefined;
    if (budgetCap && budgetCap > 0) {
      const tokenTracker = inst.skills.get('token-tracker');
      if (tokenTracker && 'getDailySpend' in tokenTracker) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const spent = (tokenTracker as any).getDailySpend() as number;
        if (spent >= budgetCap) {
          log.warn(`Budget exhausted: $${spent.toFixed(4)} / $${budgetCap.toFixed(2)}/day — refusing brain call`);
          // Stamped store key lets a one-time admin DM fire elsewhere (T2.8).
          inst.store.set('budgetExhausted', { spent, cap: budgetCap, at: Date.now() });
          await inst.adapter.send({
            chatId: message.chatId,
            text: "I've hit today's spending cap. Try again tomorrow.",
          });
          return;
        }
        // 80% warning — store a flag so the daily-digest can include it.
        if (spent >= 0.8 * budgetCap && !inst.store.get('budgetWarn80')) {
          log.warn(`Budget at ${Math.round(100 * spent / budgetCap)}% ($${spent.toFixed(4)} / $${budgetCap.toFixed(2)}/day)`);
          inst.store.set('budgetWarn80', { spent, cap: budgetCap, at: Date.now() });
        }
      }
    }

    // Build userMessage with file metadata for document attachments
    let userMessage = message.text ?? '';
    if (message.type === 'document' && files?.length) {
      const fn = message.file?.fileName || 'unnamed file';
      const readDocTool = brainTools.find(t => t.name === 'read_document');
      if (readDocTool) {
        try {
          log.info(`Pre-parsing document: ${fn}`);
          const result = await readDocTool.execute({});
          const parsed = result.content.map(c => c.text).join('\n');
          if (!result.isError) {
            const truncated = parsed.length > 15000
              ? parsed.slice(0, 15000) + '\n\n[...truncated — call read_document for full contents]'
              : parsed;
            userMessage += `\n\n[Document: "${fn}" — parsed contents below]\n${truncated}`;
            log.info(`Document pre-parsed OK: ${parsed.length} chars`);
          } else {
            log.warn(`Document pre-parse error: ${parsed.slice(0, 200)}`);
            userMessage += `\n\n[Attached document: "${fn}" — parse failed. Use read_document tool to retry.]`;
          }
        } catch (err) {
          log.warn(`Document pre-parse exception: ${err}`);
          userMessage += `\n\n[Attached document: "${fn}". Use read_document tool to extract contents.]`;
        }
      } else {
        const mt = message.file?.mimeType || 'unknown type';
        const sz = message.file?.fileSize ? `${Math.round(message.file.fileSize / 1024)} KB` : 'unknown size';
        userMessage += `\n\n[Attached document: "${fn}" (${mt}, ${sz}). Use the read_document tool to extract its contents.]`;
      }
    }
    if (!userMessage) userMessage = '[media message]';
    log.info(`UserMessage (${userMessage.length} chars): ${userMessage.slice(0, 200)}`);

    try {
      if (config.brain.provider === 'claude') {
        const brainPromise = askBrain(
          {
            name: config.name,
            model: config.brain.model,
            systemPrompt,
            maxTurns: config.brain.max_iterations ?? 5,
            maxBudgetUsd: config.brain.max_budget_usd ?? 1.0,
          },
          {
            userMessage,
            tools: brainTools,
            conversationHistory,
            contextBlocks,
          },
          log,
        );
        brainResponse = await Promise.race([
          brainPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Brain query timed out after ${BRAIN_TIMEOUT_MS / 1000}s`)), BRAIN_TIMEOUT_MS)
          ),
        ]);
        responseText = brainResponse.text;
      } else if (config.brain.provider === 'claude-cli') {
        const cliPromise = askBrainCli(
          {
            name: config.name,
            model: config.brain.model,
            systemPrompt,
            maxTurns: config.brain.max_iterations ?? 5,
          },
          {
            userMessage,
            tools: brainTools,
            conversationHistory,
            contextBlocks,
          },
        );
        brainResponse = await Promise.race([
          cliPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Brain CLI query timed out after ${BRAIN_TIMEOUT_MS / 1000}s`)), BRAIN_TIMEOUT_MS)
          ),
        ]);
        responseText = brainResponse.text;
      } else if (config.brain.provider === 'gemini') {
        // Gemini API key from env
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY environment variable not set');
        }

        const geminiResponse = await askGemini(
          {
            model: config.brain.model,
            apiKey,
            systemPrompt,
            temperature: config.brain.temperature,
            maxTokens: config.brain.max_tokens,
          },
          {
            userMessage,
            contextBlocks,
          },
        );
        responseText = geminiResponse.text;
      } else {
        responseText = 'Unsupported brain provider.';
      }
    } catch (err) {
      const errorClass = classifyError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      const ref = shortRef();
      log.error(`Brain error [class=${errorClass} ref=${ref}]: ${errMsg}`);
      responseText = renderError(errorClass, { errorMessage: errMsg, ref });
      void maybeNotifyAdmin({
        errorClass,
        errMsg,
        botName: config.name,
        adapter: inst.adapter,
        store: inst.store,
        log,
      });
    }

    // Send response (via response-formatter if available)
    let sentMessageId: string | undefined;
    if (responseText) {
      const respFormatter = inst.skills.get('response-formatter');
      if (respFormatter && 'formatAndSend' in respFormatter) {
        sentMessageId = await (respFormatter as any).formatAndSend(message.chatId, responseText);
      } else {
        sentMessageId = await inst.adapter.send({
          chatId: message.chatId,
          text: responseText,
        });
      }
    }

    // Post-response hook: attach inline keyboards from tool results
    const postResponse = storeAccess.postResponse(inst.store);
    if (postResponse?.buttons && sentMessageId && inst.adapter.edit) {
      try {
        await inst.adapter.edit(sentMessageId, message.chatId, {
          text: responseText,
          inlineKeyboard: postResponse.buttons,
        });
      } catch (err) {
        log.warn(`Post-response edit failed: ${err}`);
      }
      storeAccess.clearPostResponse(inst.store);
    }

    // Post-send persistence — each step wrapped + swallowed so a persistence
    // failure can't bubble to runtime.ts's outer catch and trigger a SECOND
    // "Sorry, I couldn't process that" reply on top of the already-sent message.
    if (historySkill && 'addMessage' in historySkill) {
      try {
        await (historySkill as any).addMessage(message.chatId, 'user', message.text ?? '[media]');
        if (responseText) {
          await (historySkill as any).addMessage(message.chatId, 'assistant', responseText);
        }
      } catch (err) {
        log.warn(`Post-send history.addMessage failed: ${err}`);
      }
    }

    if (pendingQSkill && 'recordQuestion' in pendingQSkill && responseText) {
      try {
        (pendingQSkill as any).recordQuestion(message.chatId, responseText);
      } catch (err) {
        log.warn(`Post-send pendingQ.recordQuestion failed: ${err}`);
      }
    }

    const tokenTracker = inst.skills.get('token-tracker');
    if (tokenTracker && 'recordUsage' in tokenTracker && brainResponse) {
      try {
        await (tokenTracker as any).recordUsage(
          config.brain.model,
          brainResponse.usage.costUsd,
        );
      } catch (err) {
        log.warn(`Post-send tokenTracker.recordUsage failed: ${err}`);
      }
    }
  };
}

/** Default echo processor used when echo mode is enabled. */
export function createEchoProcessor(): MessageProcessor {
  return async (message: IncomingMessage, instance: BotInstance) => {
    const responseText = `[${instance.config.name}] Received: ${message.text ?? '[non-text message]'}`;
    await instance.adapter.send({
      chatId: message.chatId,
      text: responseText,
    });
  };
}
