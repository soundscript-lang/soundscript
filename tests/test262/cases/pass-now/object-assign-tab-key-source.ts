export function main(): number {
  const target = Object.assign({}, { '\t': 1, '\t\t': 2 });
  return Object.keys(target).length;
}
