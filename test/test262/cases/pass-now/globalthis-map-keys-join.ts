export function main(): string {
  let result = '';
  for (const key of new globalThis.Map([
    ['left', 1],
    ['right', 2],
  ]).keys()) {
    result += key;
  }
  return result;
}
