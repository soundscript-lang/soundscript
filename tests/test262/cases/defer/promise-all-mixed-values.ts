export function main(value: number): Promise<(number | string)[]> {
  return Promise.all([Promise.resolve(value), 'ready']);
}
