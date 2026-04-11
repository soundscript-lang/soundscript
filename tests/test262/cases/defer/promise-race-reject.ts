export function main(): string {
  void Promise.race([
    Promise.reject(new Error('boom')),
    Promise.resolve(1),
  ]).then(() => undefined, () => undefined);
  return 'rejected';
}
