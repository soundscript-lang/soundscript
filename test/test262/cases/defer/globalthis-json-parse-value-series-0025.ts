export function main(): number {
  return globalThis.JSON.parse('{"value":25}').value;
}
