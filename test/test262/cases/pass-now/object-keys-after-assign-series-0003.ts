export function main(): number {
  return Object.keys(Object.assign({}, { left3: 3 }, { right3: 4 })).length;
}
