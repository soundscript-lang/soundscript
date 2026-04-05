export function main(): number {
  let count = 0;
  for (const _ of 'abc') count += 1;
  return count;
}
