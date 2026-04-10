export function main(): string {
  let result = '';
  for (
    const [key, value] of new Map([
      ['left', 1],
      ['right', 2],
    ]).entries()
  ) {
    result += `${key}:${value};`;
  }
  return result;
}
