export function main(left: number, right: number): Promise<number[]> {
  return Promise.all([
    Promise.resolve(left),
    Promise.resolve(right),
    Promise.resolve(left + right),
  ]);
}
