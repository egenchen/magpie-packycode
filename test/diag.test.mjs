// The failure log a user reads after a request went to a dearer group than
// expected: one line per failed attempt, nothing secret in it, and a cap so a
// long outage cannot fill the disk.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FAILURE_FILE, noteFailure } from "../src/diag.mjs"

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "packycode-diag-"))

test("a failure is one line, readable, and not a key", () => {
  const d = dir()
  try {
    noteFailure(d, { model: "claude-opus-5-5", group: "cc-sale", key: "magpie-cc-sale", status: 429, why: "rate limited", rest: 60 })
    const file = path.join(d, FAILURE_FILE)
    const [line] = fs.readFileSync(file, "utf8").trim().split("\n")
    const rec = JSON.parse(line)
    assert.equal(rec.model, "claude-opus-5-5")
    assert.equal(rec.group, "cc-sale")
    assert.equal(rec.status, 429)
    assert.ok(rec.at && !Number.isNaN(Date.parse(rec.at)))
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

test("the log is capped: a long outage rewrites it rather than filling the disk", () => {
  const d = dir()
  try {
    const file = path.join(d, FAILURE_FILE)
    fs.writeFileSync(file, "x".repeat(300 * 1024))
    noteFailure(d, { model: "claude-x", group: "cheap", status: 503 })
    const text = fs.readFileSync(file, "utf8")
    assert.ok(text.length < 1024, `still ${text.length} bytes`)
    assert.equal(JSON.parse(text.trim()).group, "cheap")
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})

test("a link where the log would go is left alone", () => {
  const d = dir()
  const outside = path.join(d, "outside.txt")
  try {
    fs.writeFileSync(outside, "keep")
    fs.symlinkSync(outside, path.join(d, FAILURE_FILE))
    noteFailure(d, { model: "claude-x", group: "cheap" })
    assert.equal(fs.readFileSync(outside, "utf8"), "keep", "nothing was written through the link")
  } finally {
    fs.rmSync(d, { recursive: true, force: true })
  }
})
