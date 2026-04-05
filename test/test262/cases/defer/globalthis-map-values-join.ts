export function main(): string {
  let result = '';
  for (const value of new globalThis.Map([
    ['left', 1],
    ['right', 2],
  ]).values()) {
    result += value;
  }
  return result;
}
