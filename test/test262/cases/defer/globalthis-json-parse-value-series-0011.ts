export function main(): number {
  return globalThis.JSON.parse('{"value":11}').value;
}
