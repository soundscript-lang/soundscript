export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 29 };
  registry.register(target, 29, token);
  return registry.unregister(token);
}
