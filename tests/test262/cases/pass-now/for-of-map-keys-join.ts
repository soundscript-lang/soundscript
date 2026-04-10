export function main(): string {
  let result = '';
  for (
    const value of new Map([
      ['left', 1],
      ['right', 2],
    ]).keys()
  ) {
    result += value;
  }
  return result;
}
