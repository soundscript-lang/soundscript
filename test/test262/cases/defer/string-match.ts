export function main(): RegExpMatchArray | null {
  return new String('ABB\\u0041BABAB').match({
    toString() {
      return '\\u0041B';
    },
  });
}
