export function main(): number {
  let count = 0;
  for (const _value of new Set(['a', 'b']).values()) {
    count += 1;
    break;
  }
  return count;
}
