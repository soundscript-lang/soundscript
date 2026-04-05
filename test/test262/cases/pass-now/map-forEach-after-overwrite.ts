export function main(): number {
  let count = 0;
  const map = new Map<string, number>();
  map.set('a', 1);
  map.set('a', 2);
  map.forEach(() => {
    count += 1;
  });
  return count;
}
