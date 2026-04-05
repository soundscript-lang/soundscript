export function main(): string {
  return Object.keys({ ...'ab' }).join(';');
}
