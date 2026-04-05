export function main(): number | undefined {
  const map = new Map([
    ['left', 1],
    ['right', 2],
  ]);
  return map.values().next().value;
}
