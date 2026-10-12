import { describe, expect, it } from "vitest";
import { alertRequest, isNtfyUrl } from "../src/notify.js";

describe("alertRequest", () => {
  it("recognises ntfy topics, hosted and self-hosted", () => {
    expect(isNtfyUrl("https://ntfy.sh/hunch-book-abc")).toBe(true);
    expect(isNtfyUrl("https://NTFY.SH/x")).toBe(true);
    expect(isNtfyUrl("https://ntfy.example.org/x")).toBe(true);
    expect(isNtfyUrl("https://hooks.slack.com/services/x")).toBe(false);
    expect(isNtfyUrl("https://example.com/ntfy.sh")).toBe(false);
    expect(isNtfyUrl("not a url")).toBe(false);
  });

  it("posts the JSON unchanged to any other webhook", () => {
    const init = alertRequest("https://hooks.example.com/x", '{"a":1}', {
      title: "t",
      text: "x",
      level: "error",
    });
    expect(init).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("posts a titled, prioritised text to ntfy", () => {
    const init = alertRequest("https://ntfy.sh/topic", '{"a":1}', {
      title: "Hunch Book keeper (monad-mainnet): job-error",
      text: "settle failed\nmarket: 0x1",
      level: "error",
      click: "https://monadscan.com/address/0x1",
    });
    expect(init.body).toBe("settle failed\nmarket: 0x1");
    expect(init.headers).toEqual({
      "content-type": "text/plain; charset=utf-8",
      Title: "Hunch Book keeper (monad-mainnet): job-error",
      Priority: "urgent",
      Tags: "rotating_light",
      Click: "https://monadscan.com/address/0x1",
    });
  });

  it("maps levels to priorities and keeps headers ASCII and the body short", () => {
    const headers = (level: string) =>
      alertRequest("https://ntfy.sh/t", "{}", { title: "Settled ✓\nnext", text: "x".repeat(5000), level })
        .headers as Record<string, string>;
    expect(headers("fail").Priority).toBe("urgent");
    expect(headers("warn").Priority).toBe("high");
    expect(headers("info").Priority).toBe("default");
    expect(headers("ok").Priority).toBe("low");
    expect(headers("other").Priority).toBe("default");
    expect(headers("info").Title).toBe("Settled ??next");
    const body = alertRequest("https://ntfy.sh/t", "{}", {
      title: "t",
      text: "x".repeat(5000),
      level: "info",
    }).body;
    expect(String(body)).toHaveLength(3500);
  });
});
