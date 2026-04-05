export async function main(): Promise<number> {
  let total = 0;
  for await (const value of new Map([
    ['a', 1],
    ['b', 2],
  ]).values()) total += value;
  return total;
}
