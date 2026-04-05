import type { Eq } from 'sts:compare';
import type { Option, Result } from 'sts:result';

export type HashCode = number;

export interface Hash<T> {
  hash(value: T): HashCode;
}

export interface HashEq<T> extends Hash<T>, Eq<T> {}

type HashEqValue<THashEq> = THashEq extends HashEq<infer TValue> ? TValue : never;

export function fromHashEq<T>(
  hash: (value: T) => HashCode,
  equals: (left: T, right: T) => boolean,
): HashEq<T>;
export function contramap<A, B>(
  hashEq: HashEq<A>,
  project: (value: B) => A,
): HashEq<B>;
export function lazyHashEq<T>(getHashEq: () => HashEq<T>): HashEq<T>;
export function arrayHash<T>(itemHash: HashEq<T>): HashEq<readonly T[]>;
export function tupleHash<const THashEqs extends readonly HashEq<unknown>[]>(
  ...elements: THashEqs
): HashEq<{ readonly [K in keyof THashEqs]: HashEqValue<THashEqs[K]> }>;
export function optionHash<T>(itemHash: HashEq<T>): HashEq<Option<T>>;
export function resultHash<T, E>(okHash: HashEq<T>, errHash: HashEq<E>): HashEq<Result<T, E>>;

export const stringHash: HashEq<string>;
export const numberHash: HashEq<number>;
export const booleanHash: HashEq<boolean>;
export const bigintHash: HashEq<bigint>;
export function combineHashes(...hashes: readonly HashCode[]): HashCode;
