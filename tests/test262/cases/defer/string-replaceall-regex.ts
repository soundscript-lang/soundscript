export function main(): string {
  const searchValue = {} as {
    [Symbol.replace]?: null;
    toString(): string;
    valueOf(): never;
  };

  searchValue[Symbol.replace] = null;
  searchValue.toString = function() {
    return '2';
  };
  searchValue.valueOf = function() {
    throw new Error('Should not be called');
  };

  return 'a2b2c'.replaceAll(searchValue, function() {
    return '';
  });
}
