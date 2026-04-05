export function main(): number {
  void Promise.allSettled([Promise.resolve(1), Promise.resolve(2)]).then(() => undefined);
  return 2;
}
