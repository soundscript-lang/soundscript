export function main(): number {
  return Object.keys(Object.assign({}, { left1: 1 }, { right1: 2 })).length;
}
