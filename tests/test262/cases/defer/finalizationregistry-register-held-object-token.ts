export function main(): boolean {
  const target = {};
  const token = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  return registry.register(target, { value: 1 }, token) === undefined;
}
