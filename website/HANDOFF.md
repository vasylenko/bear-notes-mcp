# Website Handoff

## What's Done

### Phase 1 + Phase 2 (shipped, live on Vercel)

**Pages:** index (single-page landing) + /updates (how to update)

**Sections on index page:**
1. Hero — bear mascot, trust signals (shields.io client-side), headline, tabbed install (5 clients: Claude Desktop, Claude Code, Codex CLI, Gemini CLI, Other)
2. Demo — autoplay video
3. Use Cases — 4 scenarios with prompt examples (Knowledge search, Meeting notes, Research & writing, Content creation)
4. Feature Grid — 12 tools in 3 groups
5. How it works — 8 differentiators
6. Install Guide (detailed) — same 5 tabs (shared InstallTabs component), optional settings (content replacement, new note convention), "How to receive updates" link
7. FAQ — 8 Q&As
8. Footer — Star on GitHub, nav links, attribution

**SEO:** OG tags, Twitter Cards, JSON-LD SoftwareApplication, sitemap, robots.txt, canonical URLs

**Performance:** LCP 106ms, CLS 0.02. Self-hosted Plus Jakarta Sans font (no Google Fonts CDN dependency).

**Accessibility:** Focus indicators, WCAG AA color contrast, ARIA tabs, skip-to-content link, aria-hidden on decorative SVGs, footer as proper landmark.

**Analytics:** Vercel Analytics installed.

**Design:** Light mode, Bear's red (#da2c38) accent, warm cream (#f9f8f5) background, Plus Jakarta Sans font, bear mascot illustration, branded "b" favicon. OG image (1200x630) with bear illustration + text, generated via `npm run generate:og`.

**All copy audited for factual accuracy.** No misleading claims about data privacy (scoped to server behavior). OCR properly attributed to Bear's indexing. Install commands verified against Claude Code, Codex CLI, and Gemini CLI docs.

---

## What's Pending

### Immediate (before promoting the site)

- [ ] **Custom domain** — register and connect to Vercel. Update `site` in `astro.config.mjs` (currently `https://bear-notes-mcp.com`). Candidates from master plan: `bear-notes-mcp.com`, `bear-notes-mcp.dev`, `bearmcp.com`
- [ ] **Verify OG image works** — share the URL on Twitter/LinkedIn/Slack and confirm the preview renders correctly with the bear illustration

### Phase 3 — Blog (SEO surface area)

The master plan identifies an SEO vacuum: no competitor has a blog. Even 2-3 posts would outrank a single-page competitor.

- [ ] **Set up Astro content collections** for blog posts (markdown files in `website/src/content/blog/`)
- [ ] **Blog post: "How I built bear-notes-mcp"** — origin story, technical decisions (SQLite vs x-callback-url, native node:sqlite, safety-first design). This is the "why I built this" post that establishes authority and gets organic search traffic
- [ ] **Blog post: installation guide** — detailed walkthrough with screenshots for each client. Targets long-tail keywords: "bear notes claude desktop extension", "connect bear notes to AI"
- [ ] **Blog post: comparison** — factual comparison with competitors. Not an attack piece — just a table of features. Targets "bear notes mcp server comparison"

### Phase 4 — Iterate

- [ ] **"Used with Bear by [X] developers"** — the master plan mentions this trust signal. Could derive from npm download stats or GitHub data
- [ ] **Relationship with Bear developer** — the master plan notes a relationship with Shiny Frog co-founder as a trust signal competitors can't match. Consider a testimonial or mention
- [ ] **Karpathy angle** — the master plan has a careful positioning strategy around index-first retrieval ("Your Bear database IS the index, searched in real-time with OCR"). Currently partially woven in via "searchable knowledge base" language but not explicitly referenced. Decide if this is worth a dedicated section or blog post
- [ ] **Named concept** — the SWOT identifies a weakness: no "concept" narrative (competitor has "Context Library"). Consider whether bear-notes-mcp needs a named flagship concept or whether the straightforward approach is the right brand

### Technical Debt

- [ ] **InstallGuide duplicates Hero** — both use `InstallTabs` component now (DRY), but having the exact same 5 tabs in two places on the same page is still conceptually redundant. Consider simplifying the Hero to fewer tabs or replacing the full InstallGuide section with just Optional settings + How to update
- [ ] **Codex CLI MCP compatibility** — verified working on v0.120.0 but Serhii's local npm had a `--min-release-age` constraint preventing the update. Monitor Codex CLI stability
- [ ] **Scheduled Vercel rebuilds** — trust signals (stars + downloads) update client-side via shields.io (30 min cache), but the OG image has baked-in text. If the tagline changes, re-run `npm run generate:og`. Consider a GitHub Actions cron → Vercel deploy hook for periodic rebuilds

### Not Planned (explicitly excluded)

- Dark mode — the target audience is professionals/knowledge workers, not just developers. Bear's own site is light. Decision was made deliberately after 5+ iterations
- React or heavy JS frameworks — Astro's zero-JS-by-default is the point
- Team/shared notes use case — Bear doesn't support collaboration, would be misleading
- Live GitHub API calls from the build — shields.io proxies this with its own token pool, avoiding rate limit issues on Vercel's shared IPs
