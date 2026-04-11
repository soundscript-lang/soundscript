export function main(): number {
  return Object.keys(Object.assign({}, { left2: 2 }, { right2: 3 })).length;
}
