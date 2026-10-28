import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadAutoScroll, type ThreadScrollItem } from "@/hooks/inbox/useThreadAutoScroll";

function item(key: string, overrides: Partial<ThreadScrollItem> = {}): ThreadScrollItem {
  return { key, kind: "message", direction: "inbound", ...overrides };
}

function refs() {
  const scroller = document.createElement("div");
  const content = document.createElement("div");
  const bottom = document.createElement("div");
  let top = 0;
  let height = 1000;
  Object.defineProperties(scroller, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => (top = value) },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 500 },
  });
  Object.defineProperty(bottom, "scrollIntoView", { configurable: true, value: vi.fn() });
  return {
    scrollerRef: { current: scroller },
    contentRef: { current: content },
    bottomRef: { current: bottom },
    scroller,
    getTop: () => top,
    setTop: (value: number) => (top = value),
    setHeight: (value: number) => (height = value),
    scrollIntoView: bottom.scrollIntoView as ReturnType<typeof vi.fn>,
  };
}

function setup(initialLatest = item("m-1"), initialPageCount = 1) {
  const elements = refs();
  const hook = renderHook(
    ({ latestItem, pageCount }: { latestItem: ThreadScrollItem | null; pageCount: number }) =>
      useThreadAutoScroll({
        conversationId: "c-1",
        latestItem,
        pageCount,
        currentUserId: "u-1",
        searching: false,
        scrollerRef: elements.scrollerRef,
        contentRef: elements.contentRef,
        bottomRef: elements.bottomRef,
      }),
    { initialProps: { latestItem: initialLatest, pageCount: initialPageCount } },
  );
  return { ...hook, ...elements };
}

function putReaderInHistory(result: { current: ReturnType<typeof useThreadAutoScroll> }, setTop: (n: number) => void) {
  setTop(100);
  act(() => {
    result.current.onManualScrollIntent();
    result.current.onScroll();
  });
}

describe("useThreadAutoScroll", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves a reader in history and offers a CTA for a new inbound message", () => {
    const hook = setup();
    hook.scrollIntoView.mockClear();
    putReaderInHistory(hook.result, hook.setTop);
    hook.rerender({ latestItem: item("m-2"), pageCount: 1 });

    expect(hook.result.current.hasNewMessages).toBe(true);
    expect(hook.scrollIntoView).not.toHaveBeenCalled();
    act(() => hook.result.current.scrollToEnd());
    expect(hook.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(hook.result.current.hasNewMessages).toBe(false);
  });

  it("follows the user's own send even when the loaded window stays at 50 items", () => {
    const hook = setup(item("m-50"));
    hook.scrollIntoView.mockClear();
    putReaderInHistory(hook.result, hook.setTop);
    hook.rerender({
      latestItem: item("temp-own-send", { direction: "outbound", optimistic: true }),
      pageCount: 1,
    });

    expect(hook.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(hook.result.current.hasNewMessages).toBe(false);
  });

  it("preserves the visible anchor when an older page is prepended", () => {
    const hook = setup(item("m-50"));
    hook.setTop(300);
    act(() => hook.result.current.onScroll());
    act(() => hook.result.current.rememberOlderPageAnchor());
    hook.setHeight(1500);
    hook.scrollIntoView.mockClear();

    hook.rerender({ latestItem: item("m-50"), pageCount: 2 });

    expect(hook.getTop()).toBe(800);
    expect(hook.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps following after content reflow and viewport resize", () => {
    let notifyResize: (() => void) | undefined;
    class ResizeObserverFake {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverFake);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const hook = setup();
    hook.scrollIntoView.mockClear();

    act(() => notifyResize?.());
    window.dispatchEvent(new Event("resize"));

    expect(hook.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(hook.scrollIntoView).toHaveBeenNthCalledWith(1, { behavior: "auto", block: "end" });
    expect(hook.scrollIntoView).toHaveBeenNthCalledWith(2, { behavior: "auto", block: "end" });
  });
});
