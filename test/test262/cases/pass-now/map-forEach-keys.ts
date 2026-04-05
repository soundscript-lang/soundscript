export function main(): number {
  let count = 0;
  new Map([
    ['a', 1],
    ['b', 2],
  ]).forEach(() => {
    count += 1;
  });
  return count;
}
