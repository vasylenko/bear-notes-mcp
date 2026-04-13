export const site = {
  title: 'bear-notes-mcp',
  tagline: 'Your Bear Notes, in Every AI Assistant',
  description:
    "Local MCP server that connects Bear Notes to any AI assistant. Search, create, edit, and organize your notes — runs on your Mac, reads Bear's database directly.",
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
