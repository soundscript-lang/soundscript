export function main(): string {
  let result = '';
  for (const [index, value] of ['a', 'b', 'c'].entries()) {
    if (index === 1) {
      continue;
    }
    result += value;
  }
  return result;
}
