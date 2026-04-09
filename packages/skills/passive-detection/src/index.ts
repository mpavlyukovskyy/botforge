import type { Skill, SkillContext, IncomingMessage } from '@botforge/core';

export class PassiveDetectionSkill implements Skill {
  readonly name = 'passive-detection';
  private keywords: string[] = [];
  private patterns: RegExp[] = [];
  private caseSensitive = false;

  async init(ctx: SkillContext): Promise<void> {
    const config = (ctx.config as any).passive_detection ?? (ctx.config as any).behavior?.reception;
    if (!config) return;

    this.caseSensitive = config.case_sensitive;
    this.keywords = config.keywords;
    this.patterns = config.patterns.map((p: string) =>
      new RegExp(p, this.caseSensitive ? '' : 'i')
    );

    ctx.log.info(`Passive detection: ${this.keywords.length} keywords, ${this.patterns.length} patterns`);
  }

  /** Check if a group message should be processed */
  shouldProcess(message: IncomingMessage): boolean {
    // DMs always processed
    if (!message.isGroup) return true;

    const text = message.text;
    if (!text) return false;

    const compareText = this.caseSensitive ? text : text.toLowerCase();

    // Check keywords
    for (const keyword of this.keywords) {
      const compareKeyword = this.caseSensitive ? keyword : keyword.toLowerCase();
      if (compareText.includes(compareKeyword)) return true;
    }

    // Check regex patterns
    for (const pattern of this.patterns) {
      if (pattern.test(text)) return true;
    }

    return false;
  }
}

export function createSkill(): PassiveDetectionSkill {
  return new PassiveDetectionSkill();
}

export default new PassiveDetectionSkill();
