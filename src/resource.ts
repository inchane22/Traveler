// Async loads for the screens, one per key, read synchronously once settled so a re-render never
// flashes a skeleton. Pure (no DOM): asyncView in src/render/components.ts draws each state.
//
//   loading ── resolve ──▶ ready   (kept for the key: the next read returns it at once)
//      └────── reject ───▶ failed ── next read ──▶ loading (a fresh load, so «Reintentar» is a re-render)

export type ResourceState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: unknown };

export interface Resource<T> {
  readonly promise: Promise<T>;
  readonly state: ResourceState<T>;
}

const resources = new Map<string, Resource<unknown>>();

export function resource<T>(key: string, factory: () => Promise<T>): Resource<T> {
  const existing = resources.get(key) as Resource<T> | undefined;
  if (existing && existing.state.status !== "failed") return existing;
  let state: ResourceState<T> = { status: "loading" };
  const promise = factory();
  promise.then(
    (value) => {
      state = { status: "ready", value };
    },
    (error: unknown) => {
      state = { status: "failed", error };
    },
  );
  const created: Resource<T> = {
    promise,
    get state() {
      return state;
    },
  };
  resources.set(key, created as Resource<unknown>);
  return created;
}
