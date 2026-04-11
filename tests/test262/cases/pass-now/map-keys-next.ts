export function main(): string | undefined {
  const map = new Map([
    ['left', 1],
    ['right', 2],
  ]);
  return map.keys().next().value;
}
