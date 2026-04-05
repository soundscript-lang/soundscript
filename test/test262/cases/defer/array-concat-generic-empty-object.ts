export function main(): number {
  const obj = { concat: Array.prototype.concat };
  return obj.concat().length;
}
