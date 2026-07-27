import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.mjs";

function assetEnv() {
  return {
    ASSETS: {
      async fetch(request) {
        return new Response(new URL(request.url).pathname, {
          headers: { "Content-Type": "application/octet-stream" }
        });
      }
    }
  };
}

describe("public channel guide assets", () => {
  it("allows channel images to be embedded cross-origin", async () => {
    const response = await worker.fetch(
      new Request("https://notify.example.com/channel-assets/wecom-join.jpg"),
      assetEnv()
    );
    assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    assert.match(response.headers.get("Content-Security-Policy"), /img-src 'self' data: https:/);
  });

  it("keeps other static assets same-origin", async () => {
    const response = await worker.fetch(
      new Request("https://notify.example.com/styles.css"),
      assetEnv()
    );
    assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  });
});
