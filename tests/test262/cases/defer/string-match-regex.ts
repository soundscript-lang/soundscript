export function main(): RegExpMatchArray | null {
  const regexp = {} as {
    [Symbol.match]?: null;
    toString(): string;
    valueOf(): never;
  };

  regexp[Symbol.match] = null;
  regexp.toString = function() {
    return '\\d';
  };
  regexp.valueOf = function() {
    throw new Error('Should not be called');
  };

  return 'abc'.match(regexp);
}
