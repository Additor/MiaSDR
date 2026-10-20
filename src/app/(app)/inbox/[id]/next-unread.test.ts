import { describe, expect, it } from "vitest";
import { pickNextUnread } from "./next-unread";

const row = (conversationId: string, unreadCount: number) => ({ conversationId, unreadCount });

describe("pickNextUnread", () => {
  it("takes the first unread row after the open one", () => {
    expect(pickNextUnread([row("a", 0), row("b", 1), row("c", 2), row("d", 1)], "b")).toBe("c");
    expect(pickNextUnread([row("a", 1), row("b", 0), row("c", 0), row("d", 3)], "a")).toBe("d");
  });

  it("skips the open row even though the list still counts it as unread", () => {
    expect(pickNextUnread([row("a", 1), row("b", 1)], "a")).toBe("b");
  });

  it("falls back to an unread row above the open one", () => {
    expect(pickNextUnread([row("a", 1), row("b", 0), row("c", 1)], "c")).toBe("a");
  });

  it("starts from the top when the open row is not on this page", () => {
    expect(pickNextUnread([row("a", 0), row("b", 2)], "z")).toBe("b");
  });

  it("returns null when nothing else is unread", () => {
    expect(pickNextUnread([row("a", 0), row("b", 1)], "b")).toBeNull();
    expect(pickNextUnread([], "a")).toBeNull();
  });
});
