export function main(): number {
  return Object.assign({}, { left: 1 }, { right: 2 }).left + Object.assign({}, { left: 1 }, { right: 2 }).right;
}
