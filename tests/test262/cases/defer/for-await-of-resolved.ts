export async function main(values: number[]): Promise<number> {
  async function* iterate() {
    for (const value of values) {
      yield Promise.resolve(value);
    }
  }

  let total = 0;
  for await (const value of iterate()) {
    total += value;
  }
  return total;
}
