import type { Option, Result } from 'sts:result';

export type Ordering = -1 | 0 | 1;

export interface Eq<T> {
  equals(left: T, right: T): boolean;
}

export interface Order<T> extends Eq<T> {
  compare(left: T, right: T): Ordering;
}

type EqValue<TEq> = TEq extends Eq<infer TValue> ? TValue : never;

export const stringEq: Eq<string>;
export const numberEq: Eq<number>;
export const booleanEq: Eq<boolean>;
export const bigintEq: Eq<bigint>;
export function lazyEq<T>(getEq: () => Eq<T>): Eq<T>;
export function arrayEq<T>(itemEq: Eq<T>): Eq<readonly T[]>;
export function tupleEq<const TEqs extends readonly Eq<unknown>[]>(
  ...elements: TEqs
): Eq<{ readonly [K in keyof TEqs]: EqValue<TEqs[K]> }>;
export function optionEq<T>(itemEq: Eq<T>): Eq<Option<T>>;
export function resultEq<T, E>(okEq: Eq<T>, errEq: Eq<E>): Eq<Result<T, E>>;
export function fromCompare<T>(compare: (left: T, right: T) => number): Order<T>;
export function reverse<T>(order: Order<T>): Order<T>;
export function thenBy<T>(primary: Order<T>, secondary: Order<T>): Order<T>;
