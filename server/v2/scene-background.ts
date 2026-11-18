import { createHash } from 'node:crypto';
import type { SceneBackgroundSource } from '../../shared/scene-background.js';
import type { Store } from '../store.js';
import type { PersonalMemory } from './personal-memory.js';
import { isRetiredObservationSource, type ObservationContext } from './observation-context.js';

export const backgroundContentHash = (content: string) => createHash('sha256').update(content).digest('hex');

/** Revalidate at use time: copied summaries cannot revive withdrawn owner evidence. */
export class SceneBackgrounds {
  constructor(private readonly store: Store, private readonly observations: ObservationContext, private readonly personal: PersonalMemory) {}
  async valid(sources: readonly SceneBackgroundSource[], destination?: string): Promise<boolean> {
    const retired = new Map(await Promise.all([...new Set(sources.map(source => source.caseId))]
      .map(async id => [id, await this.personal.retiredOwnerEvidence(id)] as const)));
    const target = destination ? await this.personal.retiredOwnerEvidence(destination) : undefined;
    return sources.every(ref => {
      const message = this.store.get('messages', ref.messageId);
      const source = this.observations.readOwnerMessage(ref.caseId, ref.eventId);
      return source?.messageId === ref.messageId && message?.createdAt === ref.createdAt
        && backgroundContentHash(source.content) === ref.contentHash
        && !isRetiredObservationSource(source, retired.get(ref.caseId)!)
        && (!target || !isRetiredObservationSource(source, target));
    });
  }
  async context(item: { id: string; objective: string; backgroundSources?: SceneBackgroundSource[] }): Promise<string> {
    if (!item.backgroundSources?.length) return item.objective;
    return await this.valid(item.backgroundSources, item.id) ? item.objective
      : '这份自动整理的背景引用了已纠正或撤回的原话，当前不使用其内容；可按本人要求重新整理。';
  }
}
