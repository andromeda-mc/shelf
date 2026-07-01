// deno-lint-ignore-file no-explicit-any
export function promissify<T extends (...args: any) => any>(
  fn: T,
  ...args: Parameters<T>
): Promise<ReturnType<T>> {
  return new Promise((resolve) => resolve(fn(...args)));
}
