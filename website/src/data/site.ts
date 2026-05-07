export const site = {
  title: 'bear-notes-mcp',
  tagline: 'Opinionated MCP for every AI assistant',
  description:
    'Opinionated MCP for Bear Notes. Relevance-ranked search with snippets and hierarchical tag matching. Direct SQLite reads, offline-first, network-free.',
  url: 'https://bear-notes-mcp.vercel.app',
  ogImage: '/og-image.png',
  author: {
    name: 'Serhii Vasylenko',
    url: 'https://devdosvid.blog',
  },
  links: {
    github: 'https://github.com/vasylenko/bear-notes-mcp',
    npm: 'https://www.npmjs.com/package/bear-notes-mcp',
    releases: 'https://github.com/vasylenko/bear-notes-mcp/releases',
    bearApp: 'https://bear.app',
    mcpSpec: 'https://modelcontextprotocol.io',
    support: 'https://buymeacoffee.com/vasylenko',
  },
  install: {
    claudeDesktop: {
      label: 'Claude Desktop',
      description: 'Download the .mcpb extension, double-click to install.',
      downloadUrl: 'https://github.com/vasylenko/bear-notes-mcp/releases',
    },
    claudeCode: {
      label: 'Claude Code',
      command: 'claude mcp add -s user bear-notes -- npx -y bear-notes-mcp@latest',
    },
    codex: {
      label: 'Codex CLI',
      command: 'codex mcp add bear-notes -- npx -y bear-notes-mcp@latest',
    },
    gemini: {
      label: 'Gemini CLI',
      command: 'gemini mcp add -s user bear-notes npx -- -y bear-notes-mcp@latest',
    },
    other: {
      label: 'Other',
      config: `{
  "mcpServers": {
    "bear-notes": {
      "command": "npx",
      "args": ["-y", "bear-notes-mcp@latest"]
    }
  }
}`,
    },
  },
} as const;
