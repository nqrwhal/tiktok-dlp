import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

const routes = [
  ["/", /Show video controls/i],
  ["/?video=v-1041", /Show video controls/i],
  ["/dashboard", /Open feed/i],
  ["/dashboard/videos", /Search title or creator/i],
  ["/dashboard/creators", /Import creator/i],
  ["/dashboard/settings", /Save changes/i],
];

for (const [pathname, expectedContent] of routes) {
  test(`server-renders ${pathname}`, async () => {
    const response = await render(pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

    const html = await response.text();
    assert.match(html, /<title>[^<]*Rewind<\/title>/i);
    assert.match(html, expectedContent);
    if (pathname === "/") {
      assert.match(html, />Bookmarks<\/button>/i);
      assert.equal(html.match(/preload="auto"/gi)?.length, 5);
    }
    if (pathname === "/dashboard" || pathname === "/dashboard/videos") {
      assert.match(html, /href="\/\?video=v-/i);
    }
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
  });
}
