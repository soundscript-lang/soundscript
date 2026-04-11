export function main(): string {
  let result = '';
  for (const value of new Set(['a', 'b', 'c'])) {
    result += value;
  }
  return result;
}
