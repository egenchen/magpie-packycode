// What PackyAPI's groups are, as far as choosing one goes.
//
// A group is a pool of channels with one price multiplier. Some pools are
// for a vendor's own client only: PackyAPI says using them from a
// third-party tool is what gets an account suspended. magpie is a
// third-party tool, so those are left alone unless the user opts in.
//
// The list can drift as PackyAPI renames pools; groups not named here are
// treated as ordinary, and a restricted group that is missed only shows up
// as a price that looks too good.

export const RESTRICTED = {
  cc: "CC（只允许 Claude Code 官方客户端，第三方接入会封号）",
  codex: "Codex（只允许 Codex 官方客户端）",
  "codex-sale": "Codex-sale（只允许 Codex 官方客户端）",
}

/** pools that are not a chat model's at all */
export const NON_CHAT = new Set(["image", "video", "typesafe-officially", "test"])

/** whether a group may be used with the user's options. */
export function allowedGroup(group, opts = {}) {
  if (NON_CHAT.has(group)) return false
  if (RESTRICTED[group] && !opts.include_restricted) return false
  return true
}

