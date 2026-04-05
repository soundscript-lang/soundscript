export function main(): boolean {
  const target = {};
  const token = {};
  const registry = new FinalizationRegistry<number>(() => {});
  return registry.register(target, 1, token) === undefined;
}
