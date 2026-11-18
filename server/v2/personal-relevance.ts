import { createHash } from 'node:crypto';
import type { EmbeddingModelV4 } from '@ai-sdk/provider';
import type { SharedFact } from './memory.js';

const words = new Intl.Segmenter('zh', { granularity: 'word' });
const stopWords = new Set(['the', 'and', 'for', 'with', 'please', 'this', 'that', 'what', 'how', 'can', 'you', 'your',
  '我们', '这个', '那个', '这些', '一下', '可以', '需要', '当前', '如何', '怎么', '什么', '一个', '进行', '之前', '上次']);
const newVectorsPerFocus = 16;
const vectorCacheCapacity = 2_048;

function queryTerms(value: string, limit: number): Set<string> {
  const terms = new Set<string>();
  for (const { segment, isWordLike } of words.segment(value.normalize('NFKC').toLowerCase())) {
    if (isWordLike && segment.length >= 2 && !stopWords.has(segment)) terms.add(segment);
    if (terms.size >= limit) break;
  }
  return terms;
}

export function needsMemoryAnchor(message: string): boolean {
  return message.length <= 40 && /(?:这|那|上[次回轮]|刚才|之前|上一|照旧|继续|还是|它)|\b(?:that|it|those|before|previous|continue|again|same)\b/iu.test(message)
    && queryTerms(message, 2).size < 2;
}

// Keep inputs inside the existing BGE window even for Chinese and include both ends of long text.
function embeddingText(value: string): string {
  const characters = Array.from(value.normalize('NFKC').replace(/\s+/gu, ' ').trim());
  return characters.length <= 240 ? characters.join('') : [...characters.slice(0, 160), ' ', ...characters.slice(-79)].join('');
}

function unitVector(value: number[] | undefined): Float32Array | undefined {
  if (!value?.length || !value.every(Number.isFinite)) return undefined;
  const norm = Math.hypot(...value);
  return norm > 0 && Number.isFinite(norm) ? Float32Array.from(value, coordinate => coordinate / norm) : undefined;
}

interface CachedVector { digest: string; vector: Float32Array }
interface FocusValue { value: string; lexical: number; digest?: string; similarity?: number }
export interface PersonalRelevanceFocus {
  prepare(facts: readonly SharedFact[], signal?: AbortSignal): Promise<void> | undefined;
  score(fact: SharedFact): number;
}

/** Rebuildable process-only vectors. The memory ledger and its eligibility checks own every returned value. */
export class PersonalMemoryRelevance {
  private readonly vectors = new Map<string, CachedVector>();

  constructor(private readonly embedder: EmbeddingModelV4, private readonly available: () => boolean) {}

  forFocus(focus: readonly string[]): PersonalRelevanceFocus {
    const terms = queryTerms(focus.map(text => text.slice(0, 4_000)).join('\n').slice(0, 12_000), 128);
    const lexicalCandidates = [...terms];
    const focusCache = new Map<string, FocusValue>();
    let attempted = false;
    let query: Float32Array | undefined;

    const record = (fact: SharedFact): FocusValue => {
      const previous = focusCache.get(fact.key);
      if (previous?.value === fact.value) return previous;
      const value = fact.value.normalize('NFKC').toLowerCase();
      const matches = lexicalCandidates.some(term => value.includes(term)) ? queryTerms(value, 2_000) : new Set<string>();
      const result = { value: fact.value, lexical: lexicalCandidates.filter(term => matches.has(term)).length };
      focusCache.set(fact.key, result);
      return result;
    };
    const digest = (entry: FocusValue) => entry.digest ??= createHash('sha256').update(entry.value).digest('hex');
    const cached = (key: string, entry: FocusValue) => {
      const cached = this.vectors.get(key);
      return cached?.digest === digest(entry) ? cached.vector : undefined;
    };
    return {
      prepare: (facts, signal) => {
        if (attempted || !facts.length || !terms.size || !this.available()) return;
        attempted = true;
        const queryText = embeddingText(focus.map(text => text.trim().slice(0, 320)).filter(Boolean).join('\n'));
        if (!queryText) return;
        const missing = facts.map(fact => ({ key: fact.key, entry: record(fact) })).filter(({ key, entry }) => !cached(key, entry));
        // Reserve most of each cold batch for ledger order so repeated turns can reach old entries with zero literal overlap.
        const priority = missing.filter(({ entry }) => entry.lexical > 0).sort((a, b) => b.entry.lexical - a.entry.lexical).slice(0, 4);
        const batch = [...new Set([...priority, ...missing.slice(0, newVectorsPerFocus)])].slice(0, newVectorsPerFocus);
        return (async () => {
          try {
            signal?.throwIfAborted();
            const { embeddings } = await this.embedder.doEmbed({ values: [queryText, ...batch.map(({ entry }) => embeddingText(entry.value))], abortSignal: signal });
            signal?.throwIfAborted();
            if (embeddings.length !== batch.length + 1) return;
            query = unitVector(embeddings[0]);
            if (!query) return;
            for (const [index, { key, entry }] of batch.entries()) {
              const vector = unitVector(embeddings[index + 1]);
              if (!vector || vector.length !== query.length) continue;
              this.vectors.delete(key);
              this.vectors.set(key, { digest: digest(entry), vector });
              if (this.vectors.size > vectorCacheCapacity) this.vectors.delete(this.vectors.keys().next().value!);
            }
          } catch {
            // An unavailable local model leaves lexical selection usable. An accepted cancelled embedding still drains.
            signal?.throwIfAborted();
          }
        })();
      },
      score: fact => {
        const entry = record(fact);
        const lexical = 1 - 0.6 ** entry.lexical;
        if (!query) return lexical;
        if (entry.similarity === undefined) {
          const vector = cached(fact.key, entry);
          if (!vector || vector.length !== query.length) return lexical;
          entry.similarity = vector.reduce((score, coordinate, index) => score + coordinate * query![index], 0);
        }
        return lexical + Math.max(0, entry.similarity - 0.38) * 0.7;
      },
    };
  }
}
