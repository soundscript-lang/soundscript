export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 11 };
  registry.register(target, 11, token);
  return registry.unregister(token);
}
