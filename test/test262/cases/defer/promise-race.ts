export function main(left: number, right: number): Promise<number> {
  return Promise.race([Promise.resolve(left), Promise.resolve(right)]);
}
