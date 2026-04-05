export function main(): number {
  let count = 0;
  const map = new Map([
    ['a', 1],
    ['b', 2],
  ]);
  map.forEach((_value) => {
    count += 1;
  });
  return count;
}
