export interface TikTokSendMessagePayload {
  business_id: string;
  recipient: {
    id: string;
  };
  message: {
    text?: string;
  };
}

export interface TikTokSendResponse {
  code: number;
  message: string;
  data?: {
    message_id: string;
  };
}

export interface TikTokBusinessInfo {
  business_id: string;
  username?: string;
  display_name?: string;
  profile_image?: string;
}

export interface TikTokWebhookEvent {
  event: string;
  client_id: string;
  business_id: string;
  from_user_id: string;
  to_user_id: string;
  create_time: number;
  content: {
    text?: string;
    type?: string;
  };
  message_id: string;
}

export interface TikTokWebhookPayload {
  event: string;
  data: TikTokWebhookEvent;
}
