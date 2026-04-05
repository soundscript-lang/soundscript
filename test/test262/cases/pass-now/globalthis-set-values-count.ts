export function main(): number {
  let count = 0;
  for (const _value of new globalThis.Set(['a', 'b', 'c']).values()) {
    count += 1;
  }
  return count;
}
