export function main(): string {
  const target = { left: 1, ...{ middle: 2 } };
  Object.assign(target, { right: 3 });
  return Object.keys(target).join(',');
}
