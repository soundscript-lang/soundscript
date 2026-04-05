export function main(): boolean {
  const registry = new FinalizationRegistry<number>(() => {});
  const target = {};
  const token = { id: 32 };
  registry.register(target, 32, token);
  return registry.unregister(token);
}
