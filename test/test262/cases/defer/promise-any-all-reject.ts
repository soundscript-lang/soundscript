export function main(): Promise<number> {
  return Promise.any<number>([
    Promise.reject(1),
    Promise.reject(2),
  ]).catch((error: AggregateError) => error.errors.length);
}
