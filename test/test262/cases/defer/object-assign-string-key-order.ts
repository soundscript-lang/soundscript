export function main(): string {
  const target = {};
  Object.assign(target, { zebra: 1 }, { alpha: 2 });
  return Object.keys(target).join(',');
}
