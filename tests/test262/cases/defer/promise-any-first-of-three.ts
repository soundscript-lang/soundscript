export function main(): Promise<number> {
  return Promise.any([
    Promise.resolve(1),
    Promise.reject(2),
    Promise.reject(3),
  ]);
}
