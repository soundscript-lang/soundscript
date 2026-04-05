export function main(): number {
  return Object.keys(Object.assign({}, { left4: 4 }, { right4: 5 })).length;
}
