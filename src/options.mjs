// The switches magpie keeps for the provider (`auth.options`), read at the
// moment they are used so a change reaches a running plugin.

export function optionsOf(input, id) {
  const m = input?.magpie
  if (!m) return {}
  try {
    if (typeof m.options === "function") return m.options(id) ?? {}
  } catch {
    /* an older host */
  }
  return {}
}

/** a line in magpie's log, which is where a plugin's problems are read. */
export function log(input, level, message) {
  try {
    input?.client?.app?.log?.({ body: { service: "packycode", level, message } })
  } catch {
    /* logging is a nicety */
  }
}
