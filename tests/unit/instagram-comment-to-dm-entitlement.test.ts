import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkFeatureQuota, instagramReplyComment, instagramSendMessage } = vi.hoisted(() => ({
  checkFeatureQuota: vi.fn(),
  instagramReplyComment: vi.fn(),
  instagramSendMessage: vi.fn(),
}));

vi.mock("@/lib/tenant/plan-limits", () => ({ checkFeatureQuota }));
vi.mock("@/lib/channels/instagram/client", () => ({ instagramReplyComment, instagramSendMessage }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { processCommentToDm } from "@/lib/channels/instagram/comment-to-dm";

const ORG = "org-a";
const RULE = {
  id: "rule-a",
  name: "promo",
  active: true,
  post_id: null,
  keyword_mode: "any" as const,
  keywords: [],
  reply_comment: "te respondi",
  dm_message: "olá",
  agent_id: null,
};

function adminWithMatchingRule() {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: [RULE], error: null }).then(resolve, reject);
  return { from: () => query } as never;
}

describe("Instagram Comment-to-DM entitlement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("nega fail-closed antes de responder comentário ou enviar DM quando o plano não permite", async () => {
    checkFeatureQuota.mockResolvedValue({ allowed: false, reason: "feature indisponível" });

    const result = await processCommentToDm(adminWithMatchingRule(), {
      organizationId: ORG,
      channelSessionId: "ig-session",
      instagramAccountId: "ig-account",
      token: "encrypted-token-is-not-persisted-here",
      commentId: "comment-1",
      postId: "post-1",
      commentText: "oi",
      fromUser: { id: "user-1", username: "cliente" },
    });

    expect(checkFeatureQuota).toHaveBeenCalledWith(expect.anything(), ORG, "comment_to_dm");
    expect(result).toEqual({ triggeredRules: [], dmSent: false });
    expect(instagramReplyComment).not.toHaveBeenCalled();
    expect(instagramSendMessage).not.toHaveBeenCalled();
  });
});
