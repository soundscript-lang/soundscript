export function main(): number {
  void (async () => {
    let total = 0;
    for await (const value of [1, 2, 3]) {
      total += value;
    }

    return total;
  })().catch(() => undefined);

  return 6;
}
