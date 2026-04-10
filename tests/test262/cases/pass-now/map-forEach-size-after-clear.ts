export function main(): undefined {
  const map = new Map([
    ['a', 1],
    ['b', 2],
  ]);
  const result = map.clear();
  map.forEach(() => {
    throw new Error('unreachable');
  });
  return result;
}
