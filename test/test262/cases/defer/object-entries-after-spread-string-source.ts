export function main(): string {
  return Object.entries({ ...'ab' }).map(([key, value]) => `${key}:${value}`).join(';');
}
