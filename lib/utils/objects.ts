export function omit<T, K extends (keyof T)[]>(
  val: T,
  ...keys: K
): Omit<T, K[number]> {
  const obj = Object.assign({}, val);
  for (const key of keys) {
    delete obj[key];
  }
  return obj;
}
