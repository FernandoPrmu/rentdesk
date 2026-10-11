import { describe, expect, it } from "vitest";

import { authorLabel, canEdit, COMMENT_MAX, commentPreview, commentRecipient, editCommentSchema, editSecondsLeft, newCommentSchema } from "./rules";

const ID = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-0000000000aa";
const THEM = "00000000-0000-4000-8000-0000000000bb";
const SENT = "2026-10-11T10:00:00Z";
const at = (s: string) => new Date(s);

describe("comment text (TKT-11, decision 50)", () => {
  const parse = (body: string) => newCommentSchema.safeParse({ ticketId: ID, idempotencyKey: ID, body });

  it("plain English text of 1 to 1,000 characters, trimmed", () => {
    const ok = parse("  The camera does not open on my phone.  ");
    expect(ok.success && ok.data.body).toBe("The camera does not open on my phone.");
    expect(parse("x".repeat(COMMENT_MAX)).success).toBe(true);
    expect(parse("Line one\nLine two – with “quotes”…").success).toBe(true);
  });

  it("refuses an empty, too long or non-English message", () => {
    expect(parse("   ").error?.issues[0].message).toBe("Write a message.");
    expect(parse("x".repeat(COMMENT_MAX + 1)).error?.issues[0].message).toBe("A message has at most 1,000 characters.");
    expect(parse("මීටරය කැඩිලා").error?.issues[0].message).toBe("Please use English letters only.");
    expect(parse("மீட்டர்").success).toBe(false);
    expect(editCommentSchema.safeParse({ commentId: ID, body: "" }).success).toBe(false);
  });

  it("needs real ids (idempotency key, ticket)", () => {
    expect(newCommentSchema.safeParse({ ticketId: "x", idempotencyKey: ID, body: "Hi" }).success).toBe(false);
    expect(newCommentSchema.safeParse({ ticketId: ID, idempotencyKey: "x", body: "Hi" }).success).toBe(false);
  });
});

describe("edits: the author only, for 5 minutes", () => {
  const comment = { author_id: ME, created_at: SENT };

  it("allowed up to 5 minutes after sending, then never", () => {
    expect(canEdit(comment, ME, at("2026-10-11T10:00:01Z"))).toBe(true);
    expect(canEdit(comment, ME, at("2026-10-11T10:05:00Z"))).toBe(true);
    expect(canEdit(comment, ME, at("2026-10-11T10:05:01Z"))).toBe(false);
    expect(editSecondsLeft(comment, ME, at("2026-10-11T10:03:30Z"))).toBe(90);
    expect(editSecondsLeft(comment, ME, at("2026-10-11T11:00:00Z"))).toBe(0);
  });

  it("never someone else's message", () => {
    expect(canEdit(comment, THEM, at("2026-10-11T10:00:01Z"))).toBe(false);
    expect(editSecondsLeft(comment, THEM, at("2026-10-11T10:00:01Z"))).toBe(0);
  });
});

describe("thread display and notification", () => {
  it("tells the other side", () => {
    const t = { owner_id: "o", customer_id: "c" };
    expect(commentRecipient("CUSTOMER", t)).toEqual({ userId: "o", role: "OWNER" });
    expect(commentRecipient("OWNER", t)).toEqual({ userId: "c", role: "CUSTOMER" });
  });

  it("previews one line of at most 120 characters", () => {
    expect(commentPreview("Hello\n\n  there")).toBe("Hello there");
    const long = commentPreview("a ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names the author from the viewer's side", () => {
    const names = { owner: "Lanka Copiers", customer: "Perera Stores" };
    expect(authorLabel({ author_id: ME, author_role: "OWNER" }, ME, names)).toBe("You");
    expect(authorLabel({ author_id: THEM, author_role: "OWNER" }, ME, names)).toBe("Lanka Copiers");
    expect(authorLabel({ author_id: THEM, author_role: "CUSTOMER" }, ME, names)).toBe("Perera Stores");
  });
});
