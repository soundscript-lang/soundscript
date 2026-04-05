export function main(): string | undefined {
  return 'abc'[Symbol.iterator]().next().value;
}
