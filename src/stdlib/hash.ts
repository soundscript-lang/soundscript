import type { Eq } from 'sts:compare';
import { isErr, isNone, isOk, isSome, type Option, type Result } from 'sts:result';

export type HashCode = number;

export interface Hash<T> {
  hash(value: T): HashCode;
}

export interface HashEq<T> extends Hash<T>, Eq<T> {}

type HashEqValue<THashEq> = THashEq extends HashEq<infer TValue> ? TValue : never;

export function fromHashEq<T>(
  hash: (value: T) => HashCode,
  equals: (left: T, right: T) => boolean,
): HashEq<T> {
  return {
    hash(value) {
      return normalizeHashCode(hash(value));
    },
    equals,
  };
}

export function contramap<A, B>(
  hashEq: HashEq<A>,
  project: (value: B) => A,
): HashEq<B> {
  return fromHashEq(
    (value) => hashEq.hash(project(value)),
    (left, right) => hashEq.equals(project(left), project(right)),
  );
}

export function lazyHashEq<T>(getHashEq: () => HashEq<T>): HashEq<T> {
  return fromHashEq(
    (value) => getHashEq().hash(value),
    (left, right) => getHashEq().equals(left, right),
  );
}

export function arrayHash<T>(itemHash: HashEq<T>): HashEq<readonly T[]> {
  return fromHashEq(
    (value) => combineHashes(...value.map((entry) => itemHash.hash(entry))),
    (left, right) => {
      if (left.length !== right.length) {
        return false;
      }

      for (let index = 0; index < left.length; index += 1) {
        if (!itemHash.equals(left[index]!, right[index]!)) {
          return false;
        }
      }

      return true;
    },
  );
}

export function tupleHash<const THashEqs extends readonly HashEq<unknown>[]>(
  ...elements: THashEqs
): HashEq<{ readonly [K in keyof THashEqs]: HashEqValue<THashEqs[K]> }> {
  return fromHashEq(
    (value) => {
      const values = value as readonly unknown[];
      if (values.length !== elements.length) {
        return 0;
      }
      return combineHashes(
        ...elements.map((elementHash, index) => elementHash.hash(values[index])),
      );
    },
    (left, right) => {
      const leftValues = left as readonly unknown[];
      const rightValues = right as readonly unknown[];
      if (leftValues.length !== elements.length || rightValues.length !== elements.length) {
        return false;
      }

      for (let index = 0; index < elements.length; index += 1) {
        const elementHash = elements[index];
        if (!elementHash) {
          continue;
        }
        if (!elementHash.equals(leftValues[index], rightValues[index])) {
          return false;
        }
      }

      return true;
    },
  );
}

export function optionHash<T>(itemHash: HashEq<T>): HashEq<Option<T>> {
  return fromHashEq(
    (value) =>
      isSome(value)
        ? combineHashes(stringHash.hash('some'), itemHash.hash(value.value))
        : stringHash.hash('none'),
    (left, right) => {
      if (isSome(left) && isSome(right)) {
        return itemHash.equals(left.value, right.value);
      }

      return isNone(left) && isNone(right);
    },
  );
}

export function resultHash<T, E>(okHash: HashEq<T>, errHash: HashEq<E>): HashEq<Result<T, E>> {
  return fromHashEq(
    (value) =>
      isOk(value)
        ? combineHashes(stringHash.hash('ok'), okHash.hash(value.value))
        : combineHashes(stringHash.hash('err'), errHash.hash(value.error)),
    (left, right) => {
      if (isOk(left) && isOk(right)) {
        return okHash.equals(left.value, right.value);
      }

      if (isErr(left) && isErr(right)) {
        return errHash.equals(left.error, right.error);
      }

      return false;
    },
  );
}

export const stringHash: HashEq<string> = fromHashEq(
  hashString,
  (left, right) => left === right,
);

export const numberHash: HashEq<number> = fromHashEq(
  (value) => hashString(normalizeNumberKey(value)),
  (left, right) => left === right || (Number.isNaN(left) && Number.isNaN(right)),
);

export const booleanHash: HashEq<boolean> = fromHashEq(
  (value) => value ? 1 : 0,
  (left, right) => left === right,
);

export const bigintHash: HashEq<bigint> = fromHashEq(
  (value) => hashString(value.toString()),
  (left, right) => left === right,
);

export function combineHashes(...hashes: readonly HashCode[]): HashCode {
  let hash = 0;
  for (const value of hashes) {
    hash = Math.imul(hash ^ normalizeHashCode(value), 0x01000193);
  }
  return normalizeHashCode(hash);
}

function normalizeHashCode(value: number): HashCode {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return value | 0;
}

function normalizeNumberKey(value: number): string {
  if (Number.isNaN(value)) {
    return 'NaN';
  }

  if (value === 0) {
    return '0';
  }

  return String(value);
}

function hashString(value: string): HashCode {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
