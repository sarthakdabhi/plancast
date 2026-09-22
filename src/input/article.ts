import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { PlancastError, interrupted } from "../domain/errors.js";

const fail = (message: string) => new PlancastError("INPUT_URL", message, 2);
export function articleUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail("Provide a valid public HTTP or HTTPS article URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw fail(
      "Use a public HTTP or HTTPS article URL without credentials or custom ports.",
    );
  url.hash = "";
  return url;
}
export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function publicLookup(host: string) {
  const hostname = host.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw fail(
      "Article URLs must resolve only to public internet addresses; local and private networks are not supported.",
    );
  return addresses[0]!;
}
// Pin the validated DNS result to the actual socket, including every redirect.
// No page scripts, cookies, credentials, proxies, or embedded resources are used.
export async function fetchArticle(
  value: string,
  signal: AbortSignal,
): Promise<{ html: string; url: string }> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let url = articleUrl(value);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      interrupted(signal);
      bounded.throwIfAborted();
      const address = await new Promise<
        Awaited<ReturnType<typeof publicLookup>>
      >((resolve, reject) => {
        const abort = () => reject(bounded.reason);
        bounded.addEventListener("abort", abort, { once: true });
        publicLookup(url.hostname)
          .then(resolve, reject)
          .finally(() => bounded.removeEventListener("abort", abort));
        if (bounded.aborted) abort();
      });
      const result = await new Promise<{ location?: string; html?: string }>(
        (resolve, reject) => {
          const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
            url,
            {
              signal: bounded,
              family: address.family,
              lookup: (_host, _options, callback) =>
                callback(null, address.address, address.family),
              headers: {
                "User-Agent": "Plancast/0.2 article reader",
                Accept: "text/html,application/xhtml+xml",
                "Accept-Encoding": "identity",
              },
            },
            (response) => {
              const status = response.statusCode ?? 0;
              if (
                [301, 302, 303, 307, 308].includes(status) &&
                response.headers.location
              ) {
                resolve({ location: response.headers.location });
                response.destroy();
                return;
              }
              if (status !== 200) {
                response.destroy();
                reject(
                  fail(
                    `Article request returned HTTP ${status}. Use a publicly readable article or save its text locally.`,
                  ),
                );
                return;
              }
              if (
                !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
                  response.headers["content-type"] ?? "",
                )
              ) {
                response.destroy();
                reject(
                  fail(
                    "URL must return an HTML article. Download PDFs and pass the local .pdf file.",
                  ),
                );
                return;
              }
              if (
                response.headers["content-encoding"] &&
                response.headers["content-encoding"] !== "identity"
              ) {
                response.destroy();
                reject(
                  fail(
                    "The website returned an unsupported compressed response. Save the article as text instead.",
                  ),
                );
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 3 * 1024 * 1024) {
                  reject(fail("Article HTML exceeds the 3 MB download limit."));
                  response.destroy();
                } else chunks.push(chunk);
              });
              response.on("error", reject);
              response.on("end", () => {
                try {
                  const charset =
                    /charset\s*=\s*["']?([^\s;"']+)/i.exec(
                      response.headers["content-type"] ?? "",
                    )?.[1] ?? "utf-8";
                  resolve({
                    html: new TextDecoder(charset, { fatal: true }).decode(
                      Buffer.concat(chunks),
                    ),
                  });
                } catch {
                  reject(
                    fail(
                      "Article character encoding could not be decoded. Save it as UTF-8 text.",
                    ),
                  );
                }
              });
            },
          );
          req.on("error", reject);
          req.end();
        },
      );
      if (result.location) {
        const next = articleUrl(new URL(result.location, url).href);
        if (url.protocol === "https:" && next.protocol !== "https:")
          throw fail("Article redirected from HTTPS to insecure HTTP.");
        url = next;
        continue;
      }
      return { html: result.html!, url: url.href };
    }
    throw fail("Article exceeded the five-redirect limit.");
  } catch (error) {
    interrupted(signal);
    if (error instanceof PlancastError) throw error;
    throw fail(
      bounded.aborted
        ? "Article download timed out after 30 seconds."
        : "Could not download the public article. Check the URL or save its text locally.",
    );
  }
}
export async function extractArticle(html: string, url: string) {
  const [{ JSDOM, VirtualConsole }, { Readability }] = await Promise.all([
    import("jsdom"),
    import("@mozilla/readability"),
  ]);
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    const article = new Readability(dom.window.document, {
      maxElemsToParse: 50_000,
    }).parse();
    if (!article?.content)
      throw fail(
        "No readable article found. Login pages, paywalls, and JavaScript-only pages are not supported.",
      );
    const content = new JSDOM(article.content);
    try {
      content.window.document
        .querySelectorAll("script,style,noscript,nav,form")
        .forEach((node) => node.remove());
      content.window.document
        .querySelectorAll("p,div,h1,h2,h3,h4,li,br,blockquote,section")
        .forEach((node) => {
          node.append(content.window.document.createTextNode("\n"));
        });
      const body = (content.window.document.body.textContent ?? "")
        .split(/\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
      if (body.length < 200)
        throw fail(
          "Not enough readable article text. Save the complete article as a .txt file instead.",
        );
      return {
        title: article.title ?? "Article",
        text: `${article.title ?? "Article"}\n\n${body}`,
      };
    } finally {
      content.window.close();
    }
  } catch (error) {
    if (error instanceof PlancastError) throw error;
    throw fail(
      "Article extraction failed or the page is too complex. Save the article as plain text.",
    );
  } finally {
    dom.window.close();
  }
}
