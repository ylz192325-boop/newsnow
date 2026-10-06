import assert from "node:assert/strict"
import { it, vi } from "vitest"
import { EXTERNAL_SOURCES, fetchExternalSource } from "../scripts/wechat-digest-sources.mjs"

const now = Date.UTC(2026, 9, 6, 1)
const json = data => ({ ok: true, status: 200, json: async () => data })
const text = data => ({ ok: true, status: 200, text: async () => data })

// Public Bloomberg Markets RSS entries captured on 2026-10-06.
const bloombergFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Bloomberg Markets</title>
<item><title><![CDATA[Latest Oil Market News and Analysis for Oct. 6]]></title>
<description><![CDATA[Oil steadied after losing about 2% on Monday, as rising Persian Gulf exports and a price cut by Saudi Arabia pointed to a looser market.]]></description>
<link>https://www.bloomberg.com/news/articles/2026-10-05/latest-oil-market-news-and-analysis-for-oct-6</link>
<pubDate>Mon, 05 Oct 2026 22:03:37 GMT</pubDate></item>
<item><title><![CDATA[New World Seeks More Time to Pay Bonds With $1 Billion Swap]]></title>
<description><![CDATA[New World Development Co., the stressed Hong Kong developer that’s become a symbol of the city’s efforts to move past its property slump, is seeking to buy more time to pay off creditors with a new bond exchange offer.]]></description>
<link>https://www.bloomberg.com/news/articles/2026-10-06/new-world-launches-exchange-offer-for-nearly-1-billion-of-bonds</link>
<pubDate>Tue, 06 Oct 2026 00:36:05 GMT</pubDate></item>
</channel></rss>`

// Public Huanqiu homepage anchors captured on 2026-10-06, in homepage order.
const huanqiuPage = `<html><body>
<a href="https://china.huanqiu.com/article/4TUtbY1tnlq">时政微观察丨民生为大，把老百姓的事办实办好</a>
<a href="https://china.huanqiu.com/article/4TUtkML3cYb">【新思想引领新征程】以实干开创美好未来</a>
<a href="//china.huanqiu.com/article/4TUt9ap3RXN" title="首台、首批，刷新纪录！高燃名场面上新！">首台、首批，刷新纪录！高燃名场面上新！</a>
<a href="https://world.huanqiu.com/article/4TU5WDgNXdB">习近平：民心相通是“一带一路”建设国际合作的重要内容</a>
</body></html>`

// Public GeekNews Atom entry fields captured on 2026-10-06.
const geeknewsFeed = `<feed xmlns="http://www.w3.org/2005/Atom"><title>GeekNews</title>
<entry><title>수학의 미래</title>
<link rel="self" href="https://news.hada.io/rss/news"/>
<link rel="alternate" type="text/html" href="https://news.hada.io/topic?id=34870"/>
<id>https://news.hada.io/topic?id=34870</id>
<updated>2026-10-06T11:46:40+09:00</updated><published>2026-10-06T11:46:40+09:00</published>
<content type="html">&lt;ul&gt;&lt;li&gt;AI의 도움으로 기존의 출판 가능한 수준의 결과를 쉽게 만들어내면서, &lt;strong&gt;문제 해결과 수학적 이해의 증진&lt;/strong&gt;이 분리되고 있음.&lt;/li&gt;&lt;/ul&gt;</content></entry>
<entry><title>텍사스의 한 도시, Flock 사용 관련 공공기록 공개에 200만 달러 요구</title>
<link rel="alternate" href="https://news.hada.io/topic?id=34869"/>
<id>https://news.hada.io/topic?id=34869</id><published>2026-10-06T11:43:40+09:00</published></entry>
</feed>`

// Synthetic market data follows the public Polymarket Gamma SDK contract.
function market(id, volume, overrides = {}) {
  return {
    id,
    question: `Market ${id}?`,
    slug: `market-${id}`,
    active: true,
    closed: false,
    volume,
    volume24hr: 0,
    events: [{ slug: "event-fixture" }],
    outcomes: "[\"Yes\", \"No\"]",
    outcomePrices: "[\"0.65\", \"0.35\"]",
    ...overrides,
  }
}

it("external source metadata exposes fixed official homes and identifies Huanqiu homepage order", () => {
  assert.deepEqual(Object.keys(EXTERNAL_SOURCES), ["polymarket", "huanqiu", "bloomberg", "geeknews"])
  assert.match(EXTERNAL_SOURCES.huanqiu.name, /首页/)
  assert.match(EXTERNAL_SOURCES.polymarket.name, /累计成交额/)
  assert.equal(EXTERNAL_SOURCES.huanqiu.home, "https://www.huanqiu.com/")
  assert.equal(EXTERNAL_SOURCES.bloomberg.home, "https://www.bloomberg.com/markets")
  assert.equal(EXTERNAL_SOURCES.geeknews.home, "https://news.hada.io/")
})

it("bloomberg RSS keeps feed order and provides title, canonical link, description and publication time", async () => {
  const calls = []
  const result = await fetchExternalSource("bloomberg", async (url, options) => {
    calls.push({ url: String(url), options })
    return text(bloombergFeed)
  }, now)
  assert.equal(result.status, "success")
  assert.equal(result.updatedTime, now)
  assert.equal(result.items.length, 2)
  assert.equal(result.items[0].title, "Latest Oil Market News and Analysis for Oct. 6")
  assert.equal(result.items[1].title, "New World Seeks More Time to Pay Bonds With $1 Billion Swap")
  assert.equal(result.items[0].url, "https://www.bloomberg.com/news/articles/2026-10-05/latest-oil-market-news-and-analysis-for-oct-6")
  assert.match(result.items[0].extra.hover, /Oil steadied/)
  assert.equal(result.items[0].pubDate, Date.parse("Mon, 05 Oct 2026 22:03:37 GMT"))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://feeds.bloomberg.com/markets/news.rss")
  assert.equal(calls[0].options.method, "GET")
  assert.match(calls[0].options.headers.Accept, /xml/)
  assert.ok(calls[0].options.signal instanceof AbortSignal)
})

it("huanqiu uses homepage order, normalizes protocol-relative links and deduplicates article URLs", async () => {
  const duplicate = `<a href="https://china.huanqiu.com/article/4TUtbY1tnlq">Duplicate</a>`
  const result = await fetchExternalSource("huanqiu", async (url) => {
    assert.equal(String(url), "https://www.huanqiu.com/")
    return text(huanqiuPage.replace("</body>", `${duplicate}</body>`))
  }, now)
  assert.equal(result.status, "success")
  assert.equal(result.updatedTime, now)
  assert.deepEqual(result.items.map(item => item.url), [
    "https://china.huanqiu.com/article/4TUtbY1tnlq",
    "https://china.huanqiu.com/article/4TUtkML3cYb",
    "https://china.huanqiu.com/article/4TUt9ap3RXN",
    "https://world.huanqiu.com/article/4TU5WDgNXdB",
  ])
  assert.equal(result.items[0].title, "时政微观察丨民生为大，把老百姓的事办实办好")
})

it("huanqiu only includes nonempty article links on the official domain", async () => {
  const unsafe = `<html><body>
<a href="javascript:alert(1)">Script</a>
<a href="https://china.huanqiu.com.evil.test/article/1">Imposter</a>
<a href="https://evilhuanqiu.com/article/2">Suffix</a>
<a href="https://private:secret@china.huanqiu.com/article/3">Credentials</a>
<a href="https://china.huanqiu.com:444/article/4">Different port</a>
<a href="https://www.huanqiu.com/">Home</a>
<a href="https://china.huanqiu.com/article/empty">   </a>
<a href="/article/local"><span>Valid &amp; local</span></a>
</body></html>`
  const result = await fetchExternalSource("huanqiu", async () => text(unsafe), now)
  assert.deepEqual(result.items, [{ title: "Valid & local", url: "https://www.huanqiu.com/article/local" }])
})

it("rss skips unsafe links and duplicates and converts HTML descriptions into plain text", async () => {
  const rssItem = (title, url, description = "") => `<item><title><![CDATA[${title}]]></title><link>${url}</link><description><![CDATA[${description}]]></description></item>`
  const feed = `<rss><channel>${[
    rssItem("Invalid protocol", "javascript:alert(1)"),
    rssItem("Imposter", "https://bloomberg.com.evil.test/news/a"),
    rssItem("Credentials", "https://private:secret@www.bloomberg.com/news/a"),
    rssItem("Valid & readable", "https://www.bloomberg.com/news/a", "<p>One &amp; <b>two</b>.</p><script>bad()</script>"),
    rssItem("Duplicate", "https://www.bloomberg.com/news/a"),
  ].join("")}</channel></rss>`
  const result = await fetchExternalSource("bloomberg", async () => text(feed), now)
  assert.deepEqual(result.items, [{ title: "Valid & readable", url: "https://www.bloomberg.com/news/a", extra: { hover: "One & two." } }])
})

it("geeknews Atom selects alternate topic links, preserves feed order and extracts Korean text", async () => {
  const prefixedFeed = geeknewsFeed.replace(/<(\/?)(feed|entry|title|link|id|updated|published|content)\b/g, "<$1atom:$2").replace("xmlns=", "xmlns:atom=")
  for (const fixture of [geeknewsFeed, prefixedFeed]) {
    const result = await fetchExternalSource("geeknews", async (url) => {
      assert.equal(String(url), "https://news.hada.io/rss/news")
      return text(fixture)
    }, now)
    assert.equal(result.updatedTime, now)
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0].title, "수학의 미래")
    assert.equal(result.items[0].url, "https://news.hada.io/topic?id=34870")
    assert.equal(result.items[1].url, "https://news.hada.io/topic?id=34869")
    assert.match(result.items[0].extra.hover, /AI의 도움/)
    assert.doesNotMatch(result.items[0].extra.hover, /<[^>]+>/)
    assert.equal(result.items[0].pubDate, Date.parse("2026-10-06T11:46:40+09:00"))
  }
})

it("geeknews only accepts safe official topic links and caps Atom entries at 20", async () => {
  const entry = (index, url) => `<entry><title>Topic ${index}</title><link rel="alternate" href="${url}"/></entry>`
  const unsafe = ["https://news.hada.io.evil.test/topic?id=1", "javascript:alert(1)", "https://private:secret@news.hada.io/topic?id=1", "https://news.hada.io/user/neo"]
  const entries = [...unsafe.map((url, index) => entry(index, url)), ...Array.from({ length: 25 }, (_, index) => entry(index, `https://news.hada.io/topic?id=${100 + index}`))]
  const result = await fetchExternalSource("geeknews", async () => text(`<feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`), now)
  assert.equal(result.items.length, 20)
  assert.equal(result.items[0].url, "https://news.hada.io/topic?id=100")
  assert.equal(result.items[19].url, "https://news.hada.io/topic?id=119")
})

it("rss and Atom text titles preserve code syntax while Atom HTML titles are decoded", async () => {
  const rss = `<rss><channel><item><title><![CDATA[HTML <dialog> element explained]]></title><link>https://www.bloomberg.com/news/1</link></item></channel></rss>`
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry><title type="text">HTML &lt;dialog&gt; element explained</title><link rel="alternate" href="https://news.hada.io/topic?id=1"/></entry>
<entry><title type="text">&lt;script&gt; and &lt;style&gt;</title><link rel="alternate" href="https://news.hada.io/topic?id=2"/></entry>
<entry><title type="html">&lt;b&gt;HTML&lt;/b&gt; title</title><link rel="alternate" href="https://news.hada.io/topic?id=3"/></entry>
</feed>`
  const rssResult = await fetchExternalSource("bloomberg", async () => text(rss), now)
  assert.equal(rssResult.items[0].title, "HTML <dialog> element explained")
  const atomResult = await fetchExternalSource("geeknews", async () => text(atom), now)
  assert.deepEqual(atomResult.items.map(item => item.title), ["HTML <dialog> element explained", "<script> and <style>", "HTML title"])
})

it("polymarket fetches active nonclosed markets ranked by cumulative volume and uses distinct market links", async () => {
  const result = await fetchExternalSource("polymarket", async (url, options) => {
    assert.equal(String(url), "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume&ascending=false&limit=20")
    assert.equal(options.headers.Accept, "application/json")
    return json([
      market("low", "12500.5", { volume24hr: 10000 }),
      market("high", "987654.25", { volume24hr: 1 }),
      market("inactive", "1000000", { active: false }),
      market("closed", "2000000", { closed: true }),
      market("missing-state", "3000000", { active: undefined }),
    ])
  }, now)
  assert.equal(result.status, "success")
  assert.equal(result.updatedTime, now)
  assert.deepEqual(result.items.map(item => item.title), ["Market high?", "Market low?"])
  assert.deepEqual(result.items.map(item => item.url), ["https://polymarket.com/event/event-fixture/market-high", "https://polymarket.com/event/event-fixture/market-low"])
  assert.match(result.items[0].extra.hover, /累计成交额：\$987,654\.25/)
  assert.match(result.items[0].extra.hover, /Yes：65%/)
  assert.match(result.items[0].extra.hover, /No：35%/)
})

it("polymarket caps markets at 20, ignores malformed records and treats optional probabilities independently", async () => {
  const fixtures = [
    null,
    market("blank-title", "1000000", { question: " " }),
    market("invalid-volume", "not-a-number"),
    market("infinite-volume", Infinity),
    market("unsafe-slug", 5000000, { slug: "../../unsafe" }),
    market("unsafe-event", 5000000, { events: [{ slug: "https://evil.test" }] }),
    ...Array.from({ length: 25 }, (_, index) => market(String(index), 1000 - index, { events: [], outcomes: "broken JSON", outcomePrices: "[]" })),
  ]
  const result = await fetchExternalSource("polymarket", async () => json(fixtures), now)
  assert.equal(result.items.length, 20)
  assert.equal(result.items[0].url, "https://polymarket.com/event/market-0")
  assert.equal(result.items[19].url, "https://polymarket.com/event/market-19")
  assert.equal(result.items[0].extra.hover, "累计成交额：$1,000.00")
  for (const fixture of [{ markets: [] }, [], [market("closed", "100", { closed: true })], [market("missing-volume", undefined)]]) {
    await assert.rejects(fetchExternalSource("polymarket", async () => json(fixture), now), /Invalid|Empty/)
  }
})

it("feed and homepage adapters cap usable unique entries at 20", async () => {
  const rssItems = Array.from({ length: 25 }, (_, index) => `<item><title>Headline ${index}</title><link>https://www.bloomberg.com/news/${index}</link></item>`).join("")
  const html = Array.from({ length: 25 }, (_, index) => `<a href="https://world.huanqiu.com/article/${index}">Headline ${index}</a>`).join("")
  for (const [id, fixture] of [["bloomberg", `<rss><channel>${rssItems}</channel></rss>`], ["huanqiu", html]]) {
    const result = await fetchExternalSource(id, async () => text(fixture), now)
    assert.equal(result.items.length, 20)
    assert.equal(result.items[0].title, "Headline 0")
    assert.equal(result.items[19].title, "Headline 19")
  }
})

it("empty and malformed feeds and homepages fail instead of claiming success", async () => {
  for (const [id, fixture] of [["bloomberg", "<rss><channel/></rss>"], ["bloomberg", "<rss><channel><item>"], ["bloomberg", "<html>blocked</html>"], ["huanqiu", "<html>blocked</html>"], ["geeknews", "<feed xmlns=\"http://www.w3.org/2005/Atom\"/>"], ["geeknews", "<feed><entry>"], ["geeknews", "<html>blocked</html>"]]) {
    await assert.rejects(fetchExternalSource(id, async () => text(fixture), now), /Invalid|Empty/)
  }
})

it("every external GET has a 20-second timeout and HTTP and network failures propagate", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout")
  try {
    for (const id of Object.keys(EXTERNAL_SOURCES)) {
      await assert.rejects(fetchExternalSource(id, async (_url, options) => {
        assert.equal(options.method, "GET")
        assert.ok(options.signal instanceof AbortSignal)
        return { ok: false, status: 503 }
      }, now), /HTTP/)
      await assert.rejects(fetchExternalSource(id, async () => {
        throw new Error("network unavailable")
      }, now), /network unavailable/)
    }
    assert.equal(timeout.mock.calls.length, 8)
    assert.ok(timeout.mock.calls.every(([duration]) => duration === 20_000))
    await assert.rejects(fetchExternalSource("unknown", async () => json([]), now), /Unknown external source/)
  } finally {
    timeout.mockRestore()
  }
})
