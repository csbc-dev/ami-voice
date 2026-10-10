/**
 * Every string reachable from `root` through own properties, enumerable or
 * not (`message`, `stack`, `cause`, extra fields, nested data, …) — everything
 * an error tracker or a logger could read off an error instance. Iterative, so
 * a very deep cause chain cannot overflow the test itself; a getter that
 * throws shows nothing.
 */
export function reachableStrings(root: unknown): string[] {
  const strings: string[] = [];
  const seen = new Set<object>();
  const todo: unknown[] = [root];
  while (todo.length > 0) {
    const value = todo.pop();
    if (typeof value === "string") {
      strings.push(value);
      continue;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        todo.push((value as Record<string, unknown>)[key]);
      } catch {
        // a throwing getter shows nothing
      }
    }
  }
  return strings;
}

/** The strings reachable from `root` that contain `secret`. */
export function leaksOf(root: unknown, secret: string): string[] {
  return reachableStrings(root).filter((s) => s.includes(secret));
}
