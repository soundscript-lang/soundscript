export function main(): string {
  let result = '';
  for (const [index, value] of Array.from('ab').entries()) {
    result += `${index}:${value};`;
  }
  return result;
}
