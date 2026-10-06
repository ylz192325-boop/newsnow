import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "vitest"
import { MAX_CONTENT_LENGTH, readConfig, runDigest } from "../scripts/wechat-digest.mjs"

const now = Date.UTC(2026, 9, 6, 1)
const item = (title = "今日新闻", url = "https://example.com/news") => ({ title, url })
const response = (items = [item()], updatedTime = now, status = "success") => ({ status, updatedTime, items })
const json = data => ({ ok: true, status: 200, json: async () => data })
const env = { NEWSNOW_SOURCES: "thepaper,ithome", PUSHPLUS_TOKEN: "test-private-token" }

it("configuration uses local API and validates source IDs, URL and limits", () => {
  assert.deepEqual(readConfig({}).sources, ["thepaper", "wallstreetcn-news", "cls-telegraph", "ithome", "polymarket", "hackernews", "huanqiu", "bloomberg", "juejin", "geeknews"])
  assert.equal(readConfig({}).baseUrl, "http://127.0.0.1:3000/")
  assert.equal(readConfig({}).itemsPerSource, 20)
  assert.equal(readConfig({ DIGEST_ITEMS_PER_SOURCE: "20" }).itemsPerSource, 20)
  assert.deepEqual(readConfig({ NEWSNOW_BASE_URL: "", NEWSNOW_SOURCES: "", DIGEST_ITEMS_PER_SOURCE: "" }), readConfig({}))
  assert.deepEqual(readConfig({ NEWSNOW_SOURCES: "ithome,ithome" }).sources, ["ithome"])
  for (const value of ["unknown", "../thepaper", "thepaper,"]) {
    assert.throws(() => readConfig({ NEWSNOW_SOURCES: value }), /NEWSNOW_SOURCES/)
  }
  for (const value of ["0", "21", "NaN", "1.5"]) {
    assert.throws(() => readConfig({ DIGEST_ITEMS_PER_SOURCE: value }), /DIGEST_ITEMS_PER_SOURCE/)
  }
  for (const value of ["javascript:alert(1)", "https://private:secret@example.com", "not a URL"]) {
    assert.throws(() => readConfig({ NEWSNOW_BASE_URL: value }), /NEWSNOW_BASE_URL/)
  }
})

it("news GET requests preserve source order and deduplicate within each source while retaining attribution across sources", async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (new URL(url).searchParams.get("id") === "thepaper") {
      return json(response([item("同一新闻", "https://example.com/1"), item("另一新闻", "https://example.com/2"), item("同一新闻", "https://example.com/duplicate"), item("重复地址", "https://example.com/2")]))
    }
    return json(response([item(" 同一新闻 ", "https://example.com/3"), item("同一地址", "https://example.com/2"), item("科技新闻", "https://example.com/4")]))
  }
  const result = await runDigest({ env, now, fetchImpl, dryRun: true })
  assert.equal(result.itemCount, 5)
  assert.deepEqual(result.sourceCounts, { thepaper: 2, ithome: 3 })
  assert.ok(result.content.indexOf("澎湃新闻") < result.content.indexOf("IT之家"))
  assert.equal((result.content.match(/同一新闻/g) || []).length, 2)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    const url = new URL(call.url)
    assert.equal(url.pathname, "/api/s")
    assert.equal(url.searchParams.get("latest"), "true")
    assert.equal(call.options.method, "GET")
    assert.equal(call.options.headers.Accept, "application/json")
    assert.ok(call.options.signal instanceof AbortSignal)
  }
})

it("partial failures remain visible and empty or all failed digests are not sent", async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).searchParams.get("id") === "ithome") throw new Error("unsafe upstream detail")
    return json(response())
  }
  const result = await runDigest({ env, now, fetchImpl, dryRun: true })
  assert.deepEqual(result.failedSources, ["ithome"])
  assert.match(result.content, /以下来源暂不可用.*IT之家/)
  assert.doesNotMatch(result.content, /unsafe upstream detail/)
  for (const data of [response([]), {}, response([null, {}, item("", "https://example.com")]), response([item()], now, "error")]) {
    const calls = []
    await assert.rejects(runDigest({ env, now, fetchImpl: async (url, options) => {
      calls.push(options.method)
      return json(data)
    } }), /No usable news/)
    assert.ok(calls.every(method => method === "GET"))
  }
})

it("timestamps reject stale cache, missing, nonfinite, string and unreasonable future values", async () => {
  for (const timestamp of [now - 86_400_001, undefined, Number.NaN, Infinity, String(now), now + 300_001]) {
    const data = response([item()], timestamp, "cache")
    if (timestamp === undefined) delete data.updatedTime
    await assert.rejects(runDigest({ env, now, dryRun: true, fetchImpl: async () => json(data) }), /No usable news/)
  }
  const result = await runDigest({ env, now, dryRun: true, fetchImpl: async () => json(response([item()], now - 1000, "cache")) })
  assert.match(result.content, /缓存.*API 时间/)
  assert.match(result.content, /API 时间不是文章发布时间/)
})

it("untrusted titles and descriptions are escaped; unsafe links fall back or are skipped", async () => {
  const items = [
    { ...item("<img src=x onerror=\"alert(1)\"> &", "https://example.com/?a=1&b=2"), mobileUrl: "javascript:alert(1)", extra: { hover: "<script>bad()</script>" } },
    { ...item("手机链接", "https://example.com/desktop"), mobileUrl: "https://example.com/mobile" },
    item("恶意地址", "javascript:alert(1)"),
    item("带凭证地址", "https://user:password@example.com"),
  ]
  const result = await runDigest({ env, now, dryRun: true, fetchImpl: async () => json(response(items)) })
  assert.equal(result.itemCount, 4)
  assert.deepEqual(result.sourceCounts, { thepaper: 2, ithome: 2 })
  assert.match(result.content, /&lt;img/)
  assert.match(result.content, /&lt;script&gt;/)
  assert.match(result.content, /href="https:\/\/example.com\/\?a=1&amp;b=2"/)
  assert.match(result.content, /href="https:\/\/example.com\/mobile"/)
  assert.doesNotMatch(result.content, /<img|<script>|javascript:|password|恶意地址/)
})

it("all 20 selected entries per source survive long fields by splitting below the PushPlus limit", async () => {
  const longItems = Array.from({ length: 30 }, (_, index) => ({ ...item(`新闻${index}${"&".repeat(1000)}`, `https://example.com/${index}?q=${"x".repeat(1700)}`), extra: { hover: "<".repeat(500) } }))
  const result = await runDigest({ env, now, dryRun: true, fetchImpl: async () => json(response(longItems)) })
  assert.equal(result.itemCount, 40)
  assert.deepEqual(result.sourceCounts, { thepaper: 20, ithome: 20 })
  assert.ok(result.messages.length > 1)
  assert.equal(result.messages.reduce((sum, message) => sum + message.itemCount, 0), 40)
  const nextOrdinal = new Map()
  for (const message of result.messages) {
    assert.ok(message.content.length <= MAX_CONTENT_LENGTH)
    assert.ok(message.title.length <= 100)
    assert.equal((message.content.match(/<ol\b/g) || []).length, (message.content.match(/<\/ol>/g) || []).length)
    assert.equal((message.content.match(/<li>/g) || []).length, message.itemCount)
    for (const section of message.content.matchAll(/<h2>(.*?)<\/h2><p>.*?<\/p><ol start="(\d+)">([\s\S]*?)<\/ol>/g)) {
      const [, name, start, entries] = section
      assert.equal(Number(start), nextOrdinal.get(name) || 1)
      nextOrdinal.set(name, Number(start) + (entries.match(/<li>/g) || []).length)
    }
  }
  assert.equal(nextOrdinal.size, 2)
  assert.ok([...nextOrdinal.values()].every(ordinal => ordinal === 21))
  assert.doesNotMatch(result.content, /因篇幅限制省略/)
  assert.ok(!result.content.includes("&lt;".repeat(121)))
  const shortResult = await runDigest({ env: { ...env, NEWSNOW_SOURCES: "thepaper", DIGEST_ITEMS_PER_SOURCE: "2" }, now, dryRun: true, fetchImpl: async () => json(response(longItems.map((_, index) => item(`新闻${index}`, `https://example.com/${index}`)))) })
  assert.equal(shortResult.itemCount, 2)
})

it("long earlier sources never exclude later sources or the same story under another source", async () => {
  const fillers = Array.from({ length: 5 }, (_, index) => ({
    ...item(`填充${index}${"&".repeat(180)}`, `https://example.com/${index}?q=${"x".repeat(1900)}`),
    extra: { hover: "<".repeat(120) },
  }))
  const omittedTitle = "截断后仍应出现的新闻"
  const fetchImpl = async (url) => {
    const items = new URL(url).searchParams.get("id") === "thepaper"
      ? [...fillers, item(omittedTitle, `https://example.com/long?q=${"x".repeat(2000)}`)]
      : [item(omittedTitle, "https://example.com/short")]
    return json(response(items))
  }
  const result = await runDigest({ env, now, dryRun: true, fetchImpl })
  assert.ok(result.content.includes("href=\"https://example.com/short\""), "The later source must remain represented")
  assert.equal((result.content.match(new RegExp(omittedTitle, "g")) || []).length, 2)
  assert.equal(result.itemCount, 7)
  assert.deepEqual(result.sourceCounts, { thepaper: 6, ithome: 1 })
  assert.ok(result.messages.every(message => message.content.length <= MAX_CONTENT_LENGTH))
})

it("preview needs no token, writes HTML, and never makes a POST request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newsnow-digest-"))
  try {
    const output = join(directory, "digest.html")
    const calls = []
    const result = await runDigest({ env: { NEWSNOW_SOURCES: "thepaper" }, now, dryRun: true, output, fetchImpl: async (_url, options) => {
      calls.push(options.method)
      return json(response())
    } })
    const preview = await readFile(output, "utf8")
    assert.match(preview, /^<!doctype html>/i)
    assert.match(preview, /<html lang="zh-CN">/)
    assert.match(preview, /<meta charset="UTF-8">/)
    assert.match(preview, /<meta name="viewport"/)
    assert.ok(result.messages.every(message => preview.includes(message.content)))
    assert.match(preview, /今日新闻/)
    assert.doesNotMatch(result.content, /<!doctype|<meta|<style/i)
    assert.deepEqual(calls, ["GET"])
    assert.equal(result.pushAccepted, false)
  } finally {
    await rm(directory, { recursive: true })
  }
})

it("ten sources retain 200 items and preview matches every sequential POST payload", async () => {
  const ids = ["thepaper", "wallstreetcn-news", "cls-telegraph", "ithome", "hackernews", "juejin", "solidot", "zhihu", "weibo", "baidu"]
  const expandedEnv = { ...env, NEWSNOW_SOURCES: ids.join(",") }
  const posts = []
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body))
      return json({ code: 200 })
    }
    const id = new URL(url).searchParams.get("id")
    return json(response(Array.from({ length: 30 }, (_, index) => ({
      ...item(`${id} news ${index} ${"&".repeat(80)}`, `https://example.com/${id}/${index}?q=${"x".repeat(500)}`),
      extra: { hover: "<".repeat(120) },
    }))))
  }
  const preview = await runDigest({ env: expandedEnv, now, dryRun: true, fetchImpl })
  assert.equal(posts.length, 0)
  assert.equal(preview.itemCount, 200)
  assert.ok(ids.every(id => preview.sourceCounts[id] === 20))
  assert.ok(preview.messages.length > 1)
  const sent = await runDigest({ env: expandedEnv, now, fetchImpl })
  assert.equal(posts.length, preview.messages.length)
  assert.equal(sent.acceptedParts, posts.length)
  posts.forEach((post, index) => {
    assert.equal(post.title, preview.messages[index].title)
    assert.equal(post.content, preview.messages[index].content)
    assert.ok(post.content.length <= MAX_CONTENT_LENGTH)
    assert.match(post.title, new RegExp(`${index + 1}/${posts.length}$`))
  })
})

it("a failed second part stops immediately without retrying accepted parts or sending later parts", async () => {
  let posts = 0
  await assert.rejects(runDigest({ env: { ...env, NEWSNOW_SOURCES: "thepaper" }, now, fetchImpl: async (_url, options) => {
    if (options.method === "POST") {
      posts += 1
      return json({ code: posts === 1 ? 200 : 500, msg: env.PUSHPLUS_TOKEN })
    }
    return json(response(Array.from({ length: 20 }, (_, index) => item(`long ${index}`, `https://example.com/${index}?q=${"x".repeat(1800)}`))))
  } }), (error) => {
    assert.match(error.message, /PushPlus part 2\//)
    assert.match(error.message, /1 part\(s\) accepted/)
    assert.match(error.message, /Do not retry automatically/)
    assert.ok(!error.message.includes(env.PUSHPLUS_TOKEN))
    return true
  })
  assert.equal(posts, 2)
})

it("sending requires token before any request and uses the PushPlus JSON contract", async () => {
  let requestCount = 0
  await assert.rejects(runDigest({ env: {}, now, fetchImpl: async () => {
    requestCount += 1
  } }), /PUSHPLUS_TOKEN/)
  assert.equal(requestCount, 0)
  const calls = []
  const result = await runDigest({ env, now, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options })
    return options.method === "POST" ? json({ code: 200 }) : json(response())
  } })
  const post = calls.find(call => call.options.method === "POST")
  assert.equal(post.url, "https://www.pushplus.plus/send")
  assert.equal(post.options.headers["Content-Type"], "application/json")
  assert.deepEqual(JSON.parse(post.options.body), { token: env.PUSHPLUS_TOKEN, title: result.title, content: result.content, template: "html", channel: "wechat" })
  assert.ok(post.options.signal instanceof AbortSignal)
  assert.equal(result.pushAccepted, true)
  assert.equal(calls.filter(call => call.options.method === "POST").length, 1)
})

it("rejected PushPlus requests, HTTP errors, invalid JSON, or transport failures never expose secrets or retry POST", async () => {
  for (const failure of [json({ code: 500, msg: env.PUSHPLUS_TOKEN }), json({ code: "200" }), { ok: false, status: env.PUSHPLUS_TOKEN }, { ok: true, json: async () => {
    throw new Error(env.PUSHPLUS_TOKEN)
  } }, new Error(env.PUSHPLUS_TOKEN)]) {
    let posts = 0
    await assert.rejects(runDigest({ env, now, fetchImpl: async (_url, options) => {
      if (options.method === "GET") return json(response())
      posts += 1
      if (failure instanceof Error) throw failure
      return failure
    } }), (error) => {
      assert.match(error.message, /PushPlus/)
      assert.ok(!error.message.includes(env.PUSHPLUS_TOKEN))
      return true
    })
    assert.equal(posts, 1)
  }
})
