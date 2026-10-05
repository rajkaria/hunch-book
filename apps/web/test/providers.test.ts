import { onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { makeQueryClient } from "../src/components/Providers";

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("the app's query client", () => {
  it("reads the chain even when the browser says it is offline", async () => {
    // Some browsers and in-app webviews report navigator.onLine false while requests work; the
    // default network mode would leave every page on "Loading" forever.
    onlineManager.setOnline(false);
    const client = makeQueryClient();
    const value = await Promise.race([
      client.fetchQuery({ queryKey: ["probe"], queryFn: async () => "read" }),
      new Promise((resolve) => setTimeout(() => resolve("paused"), 500)),
    ]);
    expect(value).toBe("read");
  });
});
