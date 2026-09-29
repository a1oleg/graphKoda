// Find a witnessed return to the subject, not merely a node already queued
// in the same batch. Shared dependencies alone are not cycles.
export function annotationDependencyCycle(start, dependencies, canonical = id => id) {
  start = canonical(start);
  const previous = new Map([[start, null]]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    for (const raw of dependencies.get(current) || []) {
      const next = canonical(raw);
      if (next === start) {
        const path = [current];
        while (previous.get(path[0]) !== null) path.unshift(previous.get(path[0]));
        path.push(start);
        return {
          kind: 'cyclic-dependency',
          evidenceScope: 'loaded-annotation-dependencies',
          witnessStableIds: path,
          codeRecursionConfirmed: false,
          resolution: 'external-context-required',
        };
      }
      if (!previous.has(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  return null;
}
