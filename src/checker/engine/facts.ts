import type { AnalysisFactKind, AnalysisFactValue } from './types.ts';

interface AnalysisFactCache {
  get<TFact extends AnalysisFactValue>(kind: AnalysisFactKind, key: string): TFact | undefined;
  getOrCompute<TFact extends AnalysisFactValue>(
    kind: AnalysisFactKind,
    key: string,
    compute: () => TFact,
  ): TFact;
  set<TFact extends AnalysisFactValue>(kind: AnalysisFactKind, key: string, value: TFact): void;
}

class InMemoryAnalysisFactStore implements AnalysisFactCache {
  readonly #buckets = new Map<AnalysisFactKind, Map<string, AnalysisFactValue>>();

  get<TFact extends AnalysisFactValue>(kind: AnalysisFactKind, key: string): TFact | undefined {
    return this.#buckets.get(kind)?.get(key) as TFact | undefined;
  }

  getOrCompute<TFact extends AnalysisFactValue>(
    kind: AnalysisFactKind,
    key: string,
    compute: () => TFact,
  ): TFact {
    const existing = this.get<TFact>(kind, key);
    if (existing) {
      return existing;
    }

    const created = compute();
    this.set(kind, key, created);
    return created;
  }

  set<TFact extends AnalysisFactValue>(kind: AnalysisFactKind, key: string, value: TFact): void {
    let bucket = this.#buckets.get(kind);
    if (!bucket) {
      bucket = new Map<string, AnalysisFactValue>();
      this.#buckets.set(kind, bucket);
    }

    bucket.set(key, value);
  }
}

export function createAnalysisFactStore(): AnalysisFactCache {
  return new InMemoryAnalysisFactStore();
}
