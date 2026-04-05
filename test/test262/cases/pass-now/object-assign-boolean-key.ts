export function main(): string {
  const target = {};
  Object.assign(target, { [String(true)]: 1 }, { false: 2 });
  return Object.keys(target).join(',');
}
