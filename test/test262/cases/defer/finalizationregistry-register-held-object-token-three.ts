export function main(): boolean {
  const first = {};
  const second = {};
  const third = {};
  const token = {};
  const registry = new FinalizationRegistry<{ value: number }>(() => {});
  return registry.register(first, { value: 1 }, token) === undefined &&
    registry.register(second, { value: 2 }, token) === undefined &&
    registry.register(third, { value: 3 }, token) === undefined;
}
