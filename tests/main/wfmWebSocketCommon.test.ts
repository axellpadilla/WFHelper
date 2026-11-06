import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: undefined as { getVersion?: () => string } | undefined,
  construct: vi.fn(),
}));

vi.mock("electron", () => ({
  get app() {
    return mocks.app;
  },
}));

vi.mock("ws", () => ({
  default: class MockWebSocket {
    constructor(...args: unknown[]) {
      mocks.construct(...args);
    }
  },
}));

import { createWfmWebSocket } from "../../services/wfmWebSocketCommon";

beforeEach(() => {
  mocks.construct.mockClear();
  mocks.app = { getVersion: () => "2.3.4" };
});

describe("createWfmWebSocket", () => {
  it("passes the WFHelper User-Agent with the market origin, protocol and payload limit", () => {
    createWfmWebSocket();

    expect(mocks.construct).toHaveBeenCalledWith(
      "wss://ws.warframe.market/socket",
      "wfm",
      expect.objectContaining({
        origin: "https://warframe.market",
        headers: { "User-Agent": "WFHelper/2.3.4" },
        maxPayload: 1024 * 1024,
      }),
    );
  });

  it("falls back to an unknown version when app.getVersion throws", () => {
    mocks.app = {
      getVersion: () => {
        throw new Error("version unavailable");
      },
    };

    createWfmWebSocket();

    expect(mocks.construct).toHaveBeenCalledWith(
      expect.any(String),
      "wfm",
      expect.objectContaining({ headers: { "User-Agent": "WFHelper/unknown" } }),
    );
  });

  it.each([undefined, {}])("falls back when the app version is unavailable (%s)", (app) => {
    mocks.app = app;

    createWfmWebSocket();

    expect(mocks.construct).toHaveBeenCalledWith(
      expect.any(String),
      "wfm",
      expect.objectContaining({ headers: { "User-Agent": "WFHelper/unknown" } }),
    );
  });
});
