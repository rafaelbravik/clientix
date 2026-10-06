import type {
  TikTokBusinessInfo,
  TikTokSendMessagePayload,
  TikTokSendResponse,
} from "./types";

const TIKTOK_API_VERSION = "v" + "1.3";
const TIKTOK_API_BASE = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}`;

export async function tiktokSendMessage(
  token: string,
  businessId: string,
  recipientId: string,
  text: string,
): Promise<{ messageId: string }> {
  const url = `${TIKTOK_API_BASE}/im/message/send/`;
  const payload: TikTokSendMessagePayload = {
    business_id: businessId,
    recipient: { id: recipientId },
    message: { text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Access-Token": token,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25_000),
  });

  const json = (await res.json().catch(() => ({}))) as TikTokSendResponse;

  if (!res.ok || json.code !== 0 || !json.data?.message_id) {
    const msg = json.message || `tiktok_send_failed: ${res.status}`;
    throw new Error(msg);
  }

  return { messageId: json.data.message_id };
}

export async function tiktokGetBusinessInfo(
  token: string,
  businessId: string,
): Promise<TikTokBusinessInfo> {
  const url = `${TIKTOK_API_BASE}/business/get/?business_id=${encodeURIComponent(businessId)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Access-Token": token,
    },
    signal: AbortSignal.timeout(15_000),
  });

  const json = (await res.json().catch(() => ({}))) as {
    code: number;
    message: string;
    data?: TikTokBusinessInfo;
  };

  if (!res.ok || json.code !== 0 || !json.data) {
    throw new Error(json.message || `tiktok_get_business_info_failed: ${res.status}`);
  }

  return json.data;
}
