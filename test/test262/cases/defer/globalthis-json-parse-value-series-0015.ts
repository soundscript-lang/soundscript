export function main(): number {
  return globalThis.JSON.parse('{"value":15}').value;
}
