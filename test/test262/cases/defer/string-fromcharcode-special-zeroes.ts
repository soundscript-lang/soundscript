function isPositiveZero(value: number): boolean {
  return value === 0 && 1 / value === Number.POSITIVE_INFINITY;
}

export function main(): boolean[] {
  return [
    isPositiveZero(String.fromCharCode(Number.NaN).charCodeAt(0)),
    isPositiveZero(String.fromCharCode(Number('abc')).charCodeAt(0)),
    isPositiveZero(String.fromCharCode(0).charCodeAt(0)),
    isPositiveZero(String.fromCharCode(-0).charCodeAt(0)),
    isPositiveZero(String.fromCharCode(Number.POSITIVE_INFINITY).charCodeAt(0)),
    isPositiveZero(String.fromCharCode(Number.NEGATIVE_INFINITY).charCodeAt(0)),
  ];
}
