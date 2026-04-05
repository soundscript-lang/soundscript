export function main(): string {
  let result = '';
  for (const value of 'abc') {
    if (value === 'b') {
      continue;
    }
    result += value;
  }
  return result;
}
