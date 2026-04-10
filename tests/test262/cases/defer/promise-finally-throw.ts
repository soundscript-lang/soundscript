export function main(): string {
  void Promise.resolve(1).finally(() => {
    throw new Error('boom');
  }).then(() => undefined, () => undefined);

  return 'rejected';
}
