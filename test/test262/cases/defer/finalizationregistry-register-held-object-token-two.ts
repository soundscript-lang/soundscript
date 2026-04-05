export function main(): boolean {
  const first = {};
  const second = {};
  const token = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  return registry.register(first, { value: 1 }, token) === undefined &&
    registry.register(second, { value: 2 }, token) === undefined;
}
