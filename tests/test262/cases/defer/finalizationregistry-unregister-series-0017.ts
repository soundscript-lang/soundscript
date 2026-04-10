export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 17 };
  registry.register(target, 17, token);
  return registry.unregister(token);
}
