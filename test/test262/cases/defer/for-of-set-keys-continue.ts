export function main(): string {
  let result = '';
  for (const value of new Set(['a', 'b', 'c']).keys()) {
    if (value === 'b') {
      continue;
    }
    result += value;
  }
  return result;
}
