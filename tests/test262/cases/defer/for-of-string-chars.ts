export function main(): number {
  let total = 0;
  for (const char of 'abc') {
    total += char.codePointAt(0) ?? 0;
  }
  return total;
}
