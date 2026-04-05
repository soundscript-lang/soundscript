export function main(): number {
  return 'undefined is not a function'.split(undefined, 2 ** 33).length;
}
