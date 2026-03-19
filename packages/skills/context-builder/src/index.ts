import type { Skill, SkillContext } from '@botforge/core';

export type ContextBlockBuilder = (chatId: string) => Promise<string>;

export class ContextBuilderSkill implements Skill {
  readonly name = 'context-builder';
  private builders = new Map<string, ContextBlockBuilder>();

  async init(ctx: SkillContext): Promise<void> {
    const blocks = ctx.config.memory?.context_blocks ?? [];
    ctx.log.info(`Context builder initialized with ${blocks.length} block definitions`);
  }

  /** Register a context block builder — called by bot tools at init */
  registerBuilder(type: string, builder: ContextBlockBuilder): void {
    this.builders.set(type, builder);
  }

  /** Get all context blocks for a chat — called before each askBrain() */
  async getContextBlocks(chatId: string): Promise<string[]> {
    const blocks: string[] = [];

    for (const [type, builder] of this.builders) {
      try {
        const content = await builder(chatId);
        if (content) {
          blocks.push(`<${type}>\n${content}\n</${type}>`);
        }
      } catch (err) {
        // Don't let one failed builder break all context
        blocks.push(`<${type}>\nError loading context: ${err}\n</${type}>`);
      }
    }

    return blocks;
  }
}

export function createSkill(): ContextBuilderSkill {
  return new ContextBuilderSkill();
}

export default new ContextBuilderSkill();
