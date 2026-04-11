export function main(value: number): Promise<number> {
  return Promise.race([Promise.resolve(value)]);
}
