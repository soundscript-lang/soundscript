export function main(): string {
  return Object.values({ ...'ab' }).join(';');
}
