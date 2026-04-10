export function main(): string {
  let result = '';
  for (const [key, value] of new Set(['a', 'b']).entries()) {
    result += `${key}:${value};`;
  }
  return result;
}
