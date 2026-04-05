export function main(): number {
  return globalThis.JSON.parse('{"value":23}').value;
}
