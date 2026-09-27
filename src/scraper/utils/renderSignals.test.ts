import { describe, expect, it } from "vitest";
import { needsBrowserRendering } from "./renderSignals";

describe("needsBrowserRendering", () => {
  it("renders an empty JavaScript shell", () => {
    expect(
      needsBrowserRendering(
        '<html><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script src="/app.js"></script></body></html>',
      ),
    ).toBe(true);
  });

  it("reads a server-rendered page that carries a framework marker", () => {
    const text = "Configure the client before the first request. ".repeat(5);
    expect(
      needsBrowserRendering(
        `<html><body><div id="__next" data-reactroot=""><main><h1>Guide</h1><p>${text}</p></main></div><script src="/_next/app.js"></script></body></html>`,
      ),
    ).toBe(false);
  });

  it("reads a short page that runs no scripts", () => {
    expect(needsBrowserRendering("<html><body><p>Tiny page.</p></body></html>")).toBe(
      false,
    );
  });

  it("renders a frameset", () => {
    expect(
      needsBrowserRendering(
        '<html><frameset cols="20%,80%"><frame src="nav.html"><frame src="main.html"></frameset></html>',
      ),
    ).toBe(true);
  });
});
