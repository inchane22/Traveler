// Screen loads (src/resource.ts): loading → ready is kept per key; failed loads again on the next
// read, which is what «Reintentar» relies on.
import { describe, expect, test, vi } from "vitest";
import { resource } from "../../src/resource.ts";

let n = 0;
const key = (): string => `test-${++n}`;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("resource", () => {
  test("starts loading, then is ready with the value", async () => {
    const r = resource(key(), () => Promise.resolve(42));
    expect(r.state).toEqual({ status: "loading" });
    await settle();
    expect(r.state).toEqual({ status: "ready", value: 42 });
  });

  test("a ready resource is shared by every read of its key (no second load)", async () => {
    const k = key();
    const factory = vi.fn(() => Promise.resolve("data"));
    const first = resource(k, factory);
    await settle();
    expect(resource(k, factory)).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("a loading resource is shared too", () => {
    const k = key();
    const factory = vi.fn(() => new Promise<never>(() => {}));
    expect(resource(k, factory)).toBe(resource(k, factory));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("a failed resource keeps its error, and the next read loads again", async () => {
    const k = key();
    const error = new Error("offline");
    const failing = resource(k, () => Promise.reject(error));
    failing.promise.catch(() => {});
    await settle();
    expect(failing.state).toEqual({ status: "failed", error });

    const retry = resource(k, () => Promise.resolve("back"));
    expect(retry).not.toBe(failing);
    expect(retry.state.status).toBe("loading");
    await settle();
    expect(retry.state).toEqual({ status: "ready", value: "back" });
  });

  // The old shape ({ value?, error? }) read both of these as «still loading» forever.
  test("undefined is a value and a rejection with undefined is a failure", async () => {
    const empty = resource(key(), () => Promise.resolve(undefined));
    const k = key();
    const odd = resource(k, () => Promise.reject(undefined));
    odd.promise.catch(() => {});
    await settle();
    expect(empty.state).toEqual({ status: "ready", value: undefined });
    expect(odd.state).toEqual({ status: "failed", error: undefined });
    expect(resource(k, () => Promise.resolve(1))).not.toBe(odd);
  });
});
