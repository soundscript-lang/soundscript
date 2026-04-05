export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 31 };
  registry.register(target, 31, token);
  return registry.unregister(token);
}
