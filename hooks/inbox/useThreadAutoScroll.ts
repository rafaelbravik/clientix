"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const THREAD_FOLLOW_END_THRESHOLD_PX = 96;

export interface ThreadScrollItem {
  key: string;
  kind: "message" | "note" | "passagem";
  direction?: "inbound" | "outbound";
  sentByUserId?: string | null;
  optimistic?: boolean;
}

interface Props {
  conversationId: string | null;
  latestItem: ThreadScrollItem | null;
  pageCount: number;
  currentUserId: string;
  searching: boolean;
  scrollerRef: { current: HTMLDivElement | null };
  contentRef: { current: HTMLDivElement | null };
  bottomRef: { current: HTMLDivElement | null };
}

interface OlderPageAnchor {
  scrollTop: number;
  scrollHeight: number;
  wasFollowing: boolean;
}

function isNearEnd(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <=
    THREAD_FOLLOW_END_THRESHOLD_PX
  );
}

export function useThreadAutoScroll({
  conversationId,
  latestItem,
  pageCount,
  currentUserId,
  searching,
  scrollerRef,
  contentRef,
  bottomRef,
}: Props) {
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const following = useRef(true);
  const previousConversation = useRef(conversationId);
  const previousItemKey = useRef<string | null>(null);
  const previousPageCount = useRef(pageCount);
  const olderAnchor = useRef<OlderPageAnchor | null>(null);
  const scrollingToEnd = useRef(false);
  const manualScrollIntent = useRef(false);

  const scrollToEnd = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      following.current = true;
      scrollingToEnd.current = true;
      manualScrollIntent.current = false;
      setHasNewMessages(false);
      if (bottomRef.current?.scrollIntoView) {
        bottomRef.current.scrollIntoView({ behavior, block: "end" });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
    },
    [bottomRef, scrollerRef],
  );

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scrollingToEnd.current && !manualScrollIntent.current) {
      if (isNearEnd(scroller)) scrollingToEnd.current = false;
      return;
    }
    manualScrollIntent.current = false;
    scrollingToEnd.current = false;
    following.current = isNearEnd(scroller);
    if (following.current) setHasNewMessages(false);
  }, [scrollerRef]);

  const onManualScrollIntent = useCallback(() => {
    manualScrollIntent.current = true;
    scrollingToEnd.current = false;
  }, []);

  const rememberOlderPageAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    olderAnchor.current = {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      wasFollowing: following.current,
    };
  }, [scrollerRef]);

  useLayoutEffect(() => {
    if (previousConversation.current !== conversationId) {
      previousConversation.current = conversationId;
      previousItemKey.current = null;
      previousPageCount.current = pageCount;
      olderAnchor.current = null;
      following.current = true;
      scrollingToEnd.current = false;
      manualScrollIntent.current = false;
      setHasNewMessages(false);
    }

    const scroller = scrollerRef.current;
    if (!scroller || !conversationId) return;

    const anchor = olderAnchor.current;
    if (anchor && pageCount > previousPageCount.current) {
      const addedHeight = scroller.scrollHeight - anchor.scrollHeight;
      scroller.scrollTop = anchor.scrollTop + addedHeight;
      following.current = anchor.wasFollowing;
      previousPageCount.current = pageCount;
      previousItemKey.current = latestItem?.key ?? previousItemKey.current;
      olderAnchor.current = null;
      return;
    }
    previousPageCount.current = pageCount;
    if (!latestItem) return;

    const oldKey = previousItemKey.current;
    previousItemKey.current = latestItem.key;
    if (oldKey === null) {
      // Abertura/primeiro conteúdo: ancora instantaneamente, inclusive quando
      // a conversa nasceu vazia e uma nota/passagem chegou depois.
      scrollToEnd("auto");
      return;
    }
    if (oldKey === latestItem.key) return;

    const ownSend =
      latestItem.kind === "message" &&
      latestItem.direction === "outbound" &&
      (latestItem.sentByUserId === currentUserId || latestItem.optimistic === true);
    if (ownSend) {
      scrollToEnd("smooth");
      return;
    }

    if (following.current && !searching) {
      scrollToEnd("smooth");
    } else if (latestItem.kind === "message" && latestItem.direction === "inbound") {
      setHasNewMessages(true);
    }
  }, [conversationId, currentUserId, latestItem, pageCount, searching, scrollToEnd, scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller) return;

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            // Texto longo, mídia e viewport podem mudar a altura sem trocar o ID.
            if (following.current) scrollToEnd("auto");
          });
    observer?.observe(scroller);
    if (content) observer?.observe(content);

    const onViewportResize = () => {
      if (following.current) requestAnimationFrame(() => scrollToEnd("auto"));
    };
    window.addEventListener("resize", onViewportResize);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onViewportResize);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
    };
  }, [conversationId, contentRef, scrollerRef, scrollToEnd]);

  return {
    hasNewMessages,
    scrollToEnd: () => scrollToEnd("smooth"),
    rememberOlderPageAnchor,
    onScroll,
    onManualScrollIntent,
  };
}
