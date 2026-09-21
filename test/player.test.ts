import { expect, it } from "vitest";
import { playerHtml } from "../src/audio/play.js";
it("escapes filenames so local file names cannot inject HTML or scripts", () => {
  const html = playerHtml(
    '</h1><script>alert("x")</script>&',
    Buffer.from("audio"),
    "audio/mp4",
  );
  expect(html).not.toContain("<script>alert");
  expect(html).toContain(
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;",
  );
});
it("embeds exact audio bytes and disallows remote resources", () => {
  const bytes = Buffer.from([0, 255, 48, 12, 38]);
  const html = playerHtml("plan.m4a", bytes, "audio/mp4");
  const embedded = /src="data:audio\/mp4;base64,([^"]+)"/.exec(html)?.[1];
  expect(Buffer.from(embedded!, "base64")).toEqual(bytes);
  expect(html).toContain("default-src 'none'; media-src data:");
  expect(html).not.toMatch(/https?:\/\//);
});
