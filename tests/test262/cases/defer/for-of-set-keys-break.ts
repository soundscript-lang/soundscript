export function main(): string {
  let result = '';
  for (const value of new Set(['a', 'b']).keys()) {
    result += value;
    break;
  }
  return result;
}
