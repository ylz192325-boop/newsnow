import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const sourceRegistry = JSON.parse(readFileSync(new URL("../shared/sources.json", import.meta.url), "utf8"))

export const DEFAULT_SOURCES = ["thepaper", "wallstreetcn-news", "cls-telegraph", "ithome"]
export const MAX_CONTENT_LENGTH = 19_999
const requestTimeout = 20_000
const maxCacheAge = 86_400_000

function safeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function readConfig(env = process.env) {
  const baseUrl = safeUrl(env.NEWSNOW_BASE_URL || "http://127.0.0.1:3000")
  if (!baseUrl) throw new Error("NEWSNOW_BASE_URL must be an HTTP(S) URL without credentials.")
  const sources = [...new Set((env.NEWSNOW_SOURCES || DEFAULT_SOURCES.join(",")).split(",").map(id => id.trim()))]
  if (sources.some(id => !/^[a-z0-9-]+$/.test(id) || !Object.hasOwn(sourceRegistry, id))) {
    throw new Error("NEWSNOW_SOURCES must contain known NewsNow source IDs, separated by commas.")
  }
  const itemsPerSource = Number(env.DIGEST_ITEMS_PER_SOURCE || 5)
  if (!Number.isInteger(itemsPerSource) || itemsPerSource < 1 || itemsPerSource > 10) {
    throw new Error("DIGEST_ITEMS_PER_SOURCE must be an integer from 1 to 10.")
  }
  return { baseUrl, sources, itemsPerSource }
}

function text(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : ""
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char])
}

function sourceName(id) {
  const source = sourceRegistry[id]
  return `${source.name}${source.title ? ` · ${source.title}` : ""}`
}

function formatDate(time, dateOnly = false) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
  }).format(time)
}

async function fetchSource(id, config, fetchImpl, now) {
  try {
    const url = new URL("/api/s", config.baseUrl)
    url.searchParams.set("id", id)
    url.searchParams.set("latest", "true")
    const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(requestTimeout) })
    if (!response.ok) throw new Error("HTTP failure")
    const data = await response.json()
    if (!data || !["success", "cache"].includes(data.status) || !Array.isArray(data.items)
      || typeof data.updatedTime !== "number" || !Number.isFinite(data.updatedTime)
      || now - data.updatedTime > maxCacheAge || data.updatedTime > now + 300_000) {
      throw new Error("Invalid or stale source response")
    }
    const items = data.items.slice(0, 100).flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const title = text(item.title, 1000)
      const url = safeUrl(item.mobileUrl) || safeUrl(item.url)
      return title && url ? [{ title, url, description: text(item.extra?.hover, 120) }] : []
    })
    if (!items.length) throw new Error("Empty source response")
    return { id, items, updatedTime: data.updatedTime, status: data.status }
  } catch {
    return { id, failed: true }
  }
}

function renderDigest(groups, config, now) {
  const title = `NewsNow 每日早报 · ${formatDate(now, true)}`
  const failedSources = groups.filter(group => group.failed).map(group => group.id)
  const seenTitles = new Set()
  const seenUrls = new Set()
  let content = `<h1>${escapeHtml(title)}</h1><p>汇总时间：${formatDate(now)}（北京时间）。按来源当前列表整理；API 时间不是文章发布时间。</p>`
  let itemCount = 0
  let omitted = false
  for (const group of groups.filter(group => !group.failed)) {
    const selected = []
    const selectedTitles = new Set()
    const selectedUrls = new Set()
    for (const item of group.items) {
      if (seenTitles.has(item.title) || seenUrls.has(item.url) || selectedTitles.has(item.title) || selectedUrls.has(item.url)) continue
      selectedTitles.add(item.title)
      selectedUrls.add(item.url)
      selected.push(item)
      if (selected.length === config.itemsPerSource) break
    }
    if (!selected.length) continue
    const heading = `<h2>${escapeHtml(sourceName(group.id))}</h2><p>${group.status === "cache" ? "缓存 · " : ""}API 时间：${formatDate(group.updatedTime)}（北京时间）</p><ol>`
    let section = heading
    let sectionCount = 0
    for (const item of selected) {
      const entry = `<li><a href="${escapeHtml(item.url)}">${escapeHtml(text(item.title, 180))}</a>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}</li>`
      // Reserve space for failure notices, closing tags, and the length notice.
      if (content.length + section.length + entry.length + 2000 > MAX_CONTENT_LENGTH) {
        omitted = true
        continue
      }
      section += entry
      sectionCount += 1
      seenTitles.add(item.title)
      seenUrls.add(item.url)
    }
    if (sectionCount) {
      content += `${section}</ol>`
      itemCount += sectionCount
    }
  }
  if (!itemCount) throw new Error("No usable news was returned; nothing was sent.")
  if (failedSources.length) content += `<p>以下来源暂不可用：${failedSources.map(id => escapeHtml(sourceName(id))).join("、")}。本次发送其余来源。</p>`
  if (omitted) content += "<p>部分条目因篇幅限制省略。</p>"
  content += "<p>由 NewsNow 汇总，点击标题阅读原文。</p>"
  if (content.length > MAX_CONTENT_LENGTH) throw new Error("Digest exceeds the PushPlus content limit; nothing was sent.")
  return { title, content, itemCount, failedSources }
}

function renderPreview(digest) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(digest.title)}</title>
<style>
body{margin:0;background:#f7f8fa;color:#20252c;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7}
main{max-width:760px;margin:24px auto;padding:24px;background:#fff;border-radius:12px}
h1{font-size:26px;line-height:1.3}h2{margin-top:32px;font-size:20px}
a{color:#1565c0;text-decoration:none;overflow-wrap:anywhere}a:hover{text-decoration:underline}
li{margin:14px 0}p{color:#5f6874;font-size:14px}li p{margin:6px 0}
@media(max-width:600px){main{margin:0;padding:20px;border-radius:0}h1{font-size:23px}}
</style></head><body><main>${digest.content}</main></body></html>`
}

async function sendPushPlus(digest, token, fetchImpl) {
  try {
    const response = await fetchImpl("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title: digest.title, content: digest.content, template: "html", channel: "wechat" }),
      signal: AbortSignal.timeout(requestTimeout),
    })
    if (!response.ok) throw new Error("HTTP failure")
    const data = await response.json()
    if (data?.code !== 200) throw new Error("PushPlus did not accept the request")
  } catch {
    // A timed-out POST can still succeed; retrying could send duplicate messages.
    throw new Error("PushPlus request failed or was rejected; delivery status is unknown. Do not retry automatically.")
  }
}

export async function runDigest({ env = process.env, fetchImpl = fetch, now = Date.now(), dryRun = false, output } = {}) {
  const config = readConfig(env)
  const token = typeof env.PUSHPLUS_TOKEN === "string" ? env.PUSHPLUS_TOKEN.trim() : ""
  if (!dryRun && !token) throw new Error("PUSHPLUS_TOKEN is required to send the digest.")
  if (output && !dryRun) throw new Error("An output file can only be used with --dry-run.")
  const groups = await Promise.all(config.sources.map(id => fetchSource(id, config, fetchImpl, now)))
  const digest = renderDigest(groups, config, now)
  if (dryRun && output) {
    try {
      await writeFile(output, renderPreview(digest), "utf8")
    } catch {
      throw new Error("Preview output could not be written.")
    }
  }
  if (!dryRun) await sendPushPlus(digest, token, fetchImpl)
  return { ...digest, pushAccepted: !dryRun }
}

async function main() {
  let dryRun = false
  let output
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--dry-run") dryRun = true
    else if (args[index] === "--output" && args[index + 1] && !args[index + 1].startsWith("--")) output = args[++index]
    else throw new Error("Usage: node scripts/wechat-digest.mjs [--dry-run] [--output path]")
  }
  const result = await runDigest({ dryRun, output })
  if (dryRun) console.log(output ? "Preview saved." : renderPreview(result))
  else console.log("PushPlus accepted the message; WeChat delivery must be confirmed.")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
