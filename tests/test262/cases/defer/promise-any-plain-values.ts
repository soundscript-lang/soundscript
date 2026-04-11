export function main(): Promise<number> {
  return Promise.any([1, 2, 3]);
}
