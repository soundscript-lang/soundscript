export function main(): number {
  return Object.keys({ ...{ left: 1 }, ...{ right: 2 }, ...{ up: 3 } }).length;
}
