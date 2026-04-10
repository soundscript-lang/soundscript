export function main(left: number, right: number): Promise<number> {
  return Promise.any([Promise.reject(left), Promise.resolve(right)]);
}
