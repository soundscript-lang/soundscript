import { isErr, isNone, isOk, isSome, type Option, type Result } from 'sts:result';

export type Ordering = -1 | 0 | 1;

export interface Eq<T> {
  equals(left: T, right: T): boolean;
}

export interface Order<T> extends Eq<T> {
  compare(left: T, right: T): Ordering;
}

type EqValue<TEq> = TEq extends Eq<infer TValue> ? TValue : never;

export const stringEq: Eq<string> = {
  equals(left, right) {
    return left === right;
  },
};

export const numberEq: Eq<number> = {
  equals(left, right) {
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  },
};

export const booleanEq: Eq<boolean> = {
  equals(left, right) {
    return left === right;
  },
};

export const bigintEq: Eq<bigint> = {
  equals(left, right) {
    return left === right;
  },
};

export function lazyEq<T>(getEq: () => Eq<T>): Eq<T> {
  return {
    equals(left, right) {
      return getEq().equals(left, right);
    },
  };
}

export function arrayEq<T>(itemEq: Eq<T>): Eq<readonly T[]> {
  return {
    equals(left, right) {
      if (left.length !== right.length) {
        return false;
      }

      for (let index = 0; index < left.length; index += 1) {
        if (!itemEq.equals(left[index]!, right[index]!)) {
          return false;
        }
      }

      return true;
    },
  };
}

export function tupleEq<const TEqs extends readonly Eq<unknown>[]>(
  ...elements: TEqs
): Eq<{ readonly [K in keyof TEqs]: EqValue<TEqs[K]> }> {
  return {
    equals(left, right) {
      const leftValues = left as readonly unknown[];
      const rightValues = right as readonly unknown[];
      if (leftValues.length !== elements.length || rightValues.length !== elements.length) {
        return false;
      }

      for (let index = 0; index < elements.length; index += 1) {
        const elementEq = elements[index];
        if (!elementEq) {
          continue;
        }
        if (!elementEq.equals(leftValues[index], rightValues[index])) {
          return false;
        }
      }

      return true;
    },
  };
}

export function optionEq<T>(itemEq: Eq<T>): Eq<Option<T>> {
  return {
    equals(left, right) {
      if (isSome(left) && isSome(right)) {
        return itemEq.equals(left.value, right.value);
      }

      return isNone(left) && isNone(right);
    },
  };
}

export function resultEq<T, E>(okEq: Eq<T>, errEq: Eq<E>): Eq<Result<T, E>> {
  return {
    equals(left, right) {
      if (isOk(left) && isOk(right)) {
        return okEq.equals(left.value, right.value);
      }

      if (isErr(left) && isErr(right)) {
        return errEq.equals(left.error, right.error);
      }

      return false;
    },
  };
}

export function fromCompare<T>(compare: (left: T, right: T) => number): Order<T> {
  return {
    equals(left, right) {
      return normalizeOrdering(compare(left, right)) === 0;
    },
    compare(left, right) {
      return normalizeOrdering(compare(left, right));
    },
  };
}

export function reverse<T>(order: Order<T>): Order<T> {
  return fromCompare((left, right) => order.compare(right, left));
}

export function thenBy<T>(primary: Order<T>, secondary: Order<T>): Order<T> {
  return fromCompare((left, right) => {
    const primaryOrdering = primary.compare(left, right);
    return primaryOrdering !== 0 ? primaryOrdering : secondary.compare(left, right);
  });
}

function normalizeOrdering(value: number): Ordering {
  if (value < 0) {
    return -1;
  }

  if (value > 0) {
    return 1;
  }

  return 0;
}
