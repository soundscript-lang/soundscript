export function main(): string {
  let result = '';
  for (const value of 'abc') {
    result += value;
    break;
  }
  return result;
}
