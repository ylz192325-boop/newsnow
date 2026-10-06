import { load } from "cheerio"
import { XMLParser, XMLValidator } from "fast-xml-parser"

export const EXTERNAL_SOURCES = {
  polymarket: { name: "Polymarket · 累计成交额", home: "https://polymarket.com/" },
  huanqiu: { name: "环球网 · 首页", home: "https://www.huanqiu.com/" },
  bloomberg: { name: "Bloomberg · Markets", home: "https://www.bloomberg.com/markets" },
  geeknews: { name: "GeekNews", home: "https://news.hada.io/" },
}

const sourceUrls = {
  polymarket: "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume&ascending=false&limit=20",
  huanqiu: "https://www.huanqiu.com/",
  bloomberg: "https://feeds.bloomberg.com/markets/news.rss",
  geeknews: "https://news.hada.io/rss/news",
}
const maxItems = 20

function text(value, limit = 1000) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : ""
}

function plainText(value, limit = 1000) {
  if (typeof value !== "string") return ""
  const $ = load(value, null, false)
  $("script, style, noscript").remove()
  $("br").replaceWith(" ")
  return text($.root().text(), limit)
}

function officialUrl(value, home, domain) {
  if (typeof value !== "string" || value.length > 2048) return undefined
  try {
    const url = new URL(value, home)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port
      || (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))) {
      return undefined
    }
    url.hash = ""
    return url
  } catch {
    return undefined
  }
}

function uniqueItems(items) {
  const seen = new Set()
  return items.filter((item) => {
    if (seen.has(item.url)) return false
    seen.add(item.url)
    return true
  }).slice(0, maxItems)
}

function huanqiuItems(html) {
  const $ = load(html)
  const items = []
  $("a[href]").each((_index, anchor) => {
    const title = text($(anchor).text())
    const url = officialUrl($(anchor).attr("href"), EXTERNAL_SOURCES.huanqiu.home, "huanqiu.com")
    if (title && url && /^\/article\/[^/]+\/?$/.test(url.pathname)) items.push({ title, url: url.href })
  })
  return uniqueItems(items)
}

function xmlText(value) {
  return typeof value === "string" ? value : value?.["#text"]
}

function feedItems(xml, id) {
  if (typeof xml !== "string" || /<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new Error("Invalid external feed")
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, removeNSPrefix: true })
  const parsed = parser.parse(xml)
  const channel = id === "bloomberg" ? parsed.rss?.channel : parsed.feed
  if (!channel || typeof channel !== "object") throw new Error("Invalid external feed")
  const entries = (id === "bloomberg" ? channel.item : channel.entry) || []
  const items = (Array.isArray(entries) ? entries : [entries]).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const links = Array.isArray(entry.link) ? entry.link : [entry.link]
    const link = id === "bloomberg" ? xmlText(entry.link) : links.find(link => link?.rel === "alternate" || !link?.rel)?.href
    const domain = id === "bloomberg" ? "bloomberg.com" : "news.hada.io"
    const url = officialUrl(link, EXTERNAL_SOURCES[id].home, domain)
    if (!url || (id === "geeknews" && (url.hostname !== domain || url.pathname !== "/topic" || !/^\d+$/.test(url.searchParams.get("id") || "")))) return []
    const titleValue = xmlText(entry.title)
    const title = id === "geeknews" && entry.title?.type === "html" ? plainText(titleValue) : text(titleValue)
    if (!title) return []
    const description = plainText(xmlText(entry.description || entry.summary || entry.content), 1000)
    const pubDate = Date.parse(xmlText(entry.pubDate || entry.published || entry.updated))
    return [{ title, url: url.href, ...(description ? { extra: { hover: description } } : {}), ...(Number.isFinite(pubDate) ? { pubDate } : {}) }]
  })
  return uniqueItems(items)
}

function numeric(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function arrayValue(value) {
  try {
    const result = typeof value === "string" ? JSON.parse(value) : value
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

function marketDescription(market, volume) {
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(volume)
  const outcomes = arrayValue(market.outcomes)
  const prices = arrayValue(market.outcomePrices)
  const probabilities = outcomes.length === prices.length
    ? outcomes.flatMap((outcome, index) => {
        const label = text(outcome, 100)
        const price = numeric(prices[index])
        return label && price !== undefined && price <= 1 ? [`${label}：${new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(price)}`] : []
      })
    : []
  return [`累计成交额：${amount}`, ...probabilities].join(" · ")
}

function polymarketItems(markets) {
  if (!Array.isArray(markets)) throw new Error("Invalid external market response")
  const items = markets.flatMap((market) => {
    if (!market || market.active !== true || market.closed !== false) return []
    const title = text(market.question)
    const volume = numeric(market.volume)
    const slug = market.slug
    const eventSlug = Array.isArray(market.events) && market.events.length ? market.events[0]?.slug : undefined
    if (!title || volume === undefined || typeof slug !== "string" || !/^[a-z0-9-]{1,512}$/i.test(slug)
      || (eventSlug !== undefined && (typeof eventSlug !== "string" || !/^[a-z0-9-]{1,512}$/i.test(eventSlug)))) {
      return []
    }
    const url = `${EXTERNAL_SOURCES.polymarket.home}event/${eventSlug ? `${eventSlug}/${slug}` : slug}`
    return [{ volume, item: { title, url, extra: { hover: marketDescription(market, volume) } } }]
  }).sort((left, right) => right.volume - left.volume).map(entry => entry.item)
  return uniqueItems(items)
}

export async function fetchExternalSource(id, fetchImpl, now) {
  if (!Object.hasOwn(EXTERNAL_SOURCES, id)) throw new Error("Unknown external source")
  const accept = id === "polymarket" ? "application/json" : id === "huanqiu" ? "text/html" : "application/atom+xml, application/rss+xml, application/xml, text/xml"
  const response = await fetchImpl(sourceUrls[id], { method: "GET", headers: { Accept: accept }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error("External source HTTP failure")
  const items = id === "polymarket"
    ? polymarketItems(await response.json())
    : id === "huanqiu"
      ? huanqiuItems(await response.text())
      : feedItems(await response.text(), id)
  if (!items.length) throw new Error("Empty external source response")
  return { status: "success", updatedTime: now, items }
}
