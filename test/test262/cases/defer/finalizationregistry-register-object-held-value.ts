export function main(): boolean {
  const target = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  return registry.register(target, { value: 1 }) === undefined;
}
