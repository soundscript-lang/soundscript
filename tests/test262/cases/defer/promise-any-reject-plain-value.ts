export function main(): Promise<number> {
  return Promise.any([Promise.reject(1), 2]);
}
