export async function main(): Promise<number> {
  let total = 0;
  for await (const value of new Map([
    ['left', Promise.resolve(1)],
    ['right', Promise.resolve(2)],
    ['third', Promise.resolve(3)],
  ]).values()) {
    if (value === 2) {
      continue;
    }
    total += value;
  }
  return total;
}
