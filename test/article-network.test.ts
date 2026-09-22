import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
const state = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: state.lookup }));
vi.mock("node:https", () => ({ request: state.request }));
vi.mock("node:http", () => ({ request: state.request }));
import { fetchArticle } from "../src/input/article.js";
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  state.lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
});
function reply(
  status: number,
  headers: Record<string, string>,
  body = "hello",
) {
  state.request.mockImplementationOnce((_url, options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () =>
      queueMicrotask(() => {
        options.lookup("example.com", {}, (error: unknown, address: string) => {
          expect(error).toBeNull();
          expect(address).toBe("1.1.1.1");
        });
        const res = Object.assign(Readable.from([Buffer.from(body)]), {
          statusCode: status,
          headers,
        });
        callback(res);
      });
    return req;
  });
}
it("pins a public address and revalidates redirects before connecting", async () => {
  reply(302, { location: "http://127.0.0.1/admin" });
  state.lookup
    .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }])
    .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  await expect(fetchArticle("http://example.com", signal())).rejects.toThrow(
    "public internet",
  );
  expect(state.request).toHaveBeenCalledTimes(1);
});
it("rejects mixed private/public DNS answers before any request", async () => {
  state.lookup.mockResolvedValue([
    { address: "1.1.1.1", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  await expect(fetchArticle("https://example.com", signal())).rejects.toThrow(
    "public internet",
  );
  expect(state.request).not.toHaveBeenCalled();
});
it("returns HTML and the final redirect URL", async () => {
  reply(302, { location: "/article" });
  reply(
    200,
    { "content-type": "text/html; charset=utf-8" },
    "<article>text</article>",
  );
  expect(await fetchArticle("https://example.com", signal())).toEqual({
    url: "https://example.com/article",
    html: "<article>text</article>",
  });
});
it("rejects binary responses, HTTP errors, huge downloads, and HTTPS downgrades", async () => {
  reply(200, { "content-type": "application/pdf" });
  await expect(fetchArticle("https://example.com", signal())).rejects.toThrow(
    "HTML",
  );
  reply(403, {});
  await expect(fetchArticle("https://example.com", signal())).rejects.toThrow(
    "HTTP 403",
  );
  reply(200, { "content-type": "text/html" }, "x".repeat(3 * 1024 * 1024 + 1));
  await expect(fetchArticle("https://example.com", signal())).rejects.toThrow(
    "3 MB",
  );
  reply(302, { location: "http://example.com" });
  await expect(fetchArticle("https://example.com", signal())).rejects.toThrow(
    "insecure",
  );
});
it("bounds redirect loops and respects interruption before connecting", async () => {
  for (let i = 0; i < 6; i++) reply(302, { location: "/again" });
  await expect(fetchArticle("https://example.com", signal())).rejects.toThrow(
    "five-redirect",
  );
  const controller = new AbortController();
  controller.abort();
  state.request.mockClear();
  await expect(
    fetchArticle("https://example.com", controller.signal),
  ).rejects.toMatchObject({ exitCode: 130 });
  expect(state.request).not.toHaveBeenCalled();
});
