export function main(): number {
  return Object.values(Object.assign({}, { left: 1 }, { right: 2 })).length;
}
