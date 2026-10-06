import { graphBaseUrl } from "../meta/graph-base";
import type {
  InstagramAccountInfo,
  InstagramSendMessagePayload,
  InstagramSendResponse,
} from "./types";

export async function instagramSendMessage(
  token: string,
  accountId: string,
  recipientId: string,
  text: string,
): Promise<{ messageId: string }> {
  const url = `${graphBaseUrl()}/${accountId}/messages`;
  const payload: InstagramSendMessagePayload = {
    recipient: { id: recipientId },
    message: { text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });

  const json = (await res.json().catch(() => ({}))) as InstagramSendResponse;

  if (!res.ok || json.error || !json.message_id) {
    const msg = json.error?.message || `instagram_send_failed: ${res.status}`;
    throw new Error(msg);
  }

  return { messageId: json.message_id };
}

export async function instagramSendMedia(
  token: string,
  accountId: string,
  recipientId: string,
  type: "image" | "audio" | "video" | "file",
  mediaUrl: string,
): Promise<{ messageId: string }> {
  const url = `${graphBaseUrl()}/${accountId}/messages`;
  const payload: InstagramSendMessagePayload = {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type,
        payload: { url: mediaUrl },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  const json = (await res.json().catch(() => ({}))) as InstagramSendResponse;

  if (!res.ok || json.error || !json.message_id) {
    const msg = json.error?.message || `instagram_send_media_failed: ${res.status}`;
    throw new Error(msg);
  }

  return { messageId: json.message_id };
}

export async function instagramReplyComment(
  token: string,
  commentId: string,
  message: string,
): Promise<{ commentId: string }> {
  const url = `${graphBaseUrl()}/${commentId}/replies`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message: string } };

  if (!res.ok || json.error || !json.id) {
    const msg = json.error?.message || `instagram_reply_comment_failed: ${res.status}`;
    throw new Error(msg);
  }

  return { commentId: json.id };
}

export async function instagramGetAccount(
  token: string,
  accountId: string,
): Promise<InstagramAccountInfo> {
  const url = `${graphBaseUrl()}/${accountId}?fields=id,username,name,profile_picture_url`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  const json = (await res.json().catch(() => ({}))) as InstagramAccountInfo & {
    error?: { message: string };
  };

  if (!res.ok || json.error || !json.id) {
    throw new Error(json.error?.message || `instagram_get_account_failed: ${res.status}`);
  }

  return json;
}
