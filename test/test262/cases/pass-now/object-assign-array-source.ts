export function main(): number {
  const target = {};
  Object.assign(target, ['left', 'right']);
  return Object.keys(target).length;
}
