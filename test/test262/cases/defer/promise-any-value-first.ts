export function main(): Promise<number> {
  return Promise.any([1, Promise.reject(2)]);
}
