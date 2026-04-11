export function main(): boolean {
  const target = Object.assign({ '\t': 1 }, { '\t\t': 2 });
  return Object.hasOwn(target, '\t');
}
