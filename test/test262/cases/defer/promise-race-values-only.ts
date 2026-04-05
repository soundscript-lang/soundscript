export function main(): Promise<number> {
  return Promise.race([1, 2, 3]);
}
