export interface InstagramRecipient {
  id: string;
}

export interface InstagramSendMessagePayload {
  recipient: InstagramRecipient;
  message: {
    text?: string;
    attachment?: {
      type: "image" | "audio" | "video" | "file";
      payload: {
        url: string;
        is_reusable?: boolean;
      };
    };
  };
}

export interface InstagramSendResponse {
  recipient_id?: string;
  message_id?: string;
  error?: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface InstagramAccountInfo {
  id: string;
  username?: string;
  name?: string;
  profile_picture_url?: string;
}

export interface InstagramWebhookMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    attachments?: Array<{
      type: "image" | "audio" | "video" | "file" | "share";
      payload: {
        url?: string;
        id?: string;
        mime_type?: string;
        filename?: string;
        name?: string;
        caption?: string;
      };
    }>;
    reply_to?: {
      mid: string;
    };
  };
  postback?: {
    mid: string;
    title: string;
    payload: string;
  };
}

export interface InstagramCommentChange {
  field: "comments";
  value: {
    id: string;
    text: string;
    from: {
      id: string;
      username: string;
    };
    post: {
      id: string;
    };
    created_time?: number;
  };
}

export interface InstagramWebhookEntry {
  id: string;
  time: number;
  messaging?: InstagramWebhookMessagingEvent[];
  changes?: InstagramCommentChange[];
}

export interface InstagramWebhookPayload {
  object: "instagram" | "page";
  entry: InstagramWebhookEntry[];
}
