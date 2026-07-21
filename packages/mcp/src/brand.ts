/** Canonical brand chip SVG (ADR 154). Mirrors `docs/design/assets/chip.svg`. */
export const CHIP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="musterd">
  <rect width="32" height="32" rx="7" fill="#E1AD01"/>
  <path fill="#18181B" d="M7.5 22V11.8h2.3v2.4c0-1.7 1-2.8 2.5-2.8 1.4 0 2.3.9 2.3 2.6V22h-2.3v-5.6c0-.9-.5-1.4-1.2-1.4-.8 0-1.2.5-1.2 1.4V22H7.5zm7.2 0v-6.2c0-1.9 1-3 2.6-3 1.1 0 1.9.5 2.2 1.3v-1.1h2.3V22h-2.3v-5.7c0-.9-.5-1.4-1.2-1.4-.8 0-1.2.5-1.2 1.4V22h-2.4z"/>
  <rect x="24.5" y="18" width="2.5" height="10" rx="0.4" fill="#18181B"/>
</svg>`;

/** Data URI for MCP `serverInfo.icons` (ADR 154). */
export function chipIconDataUri(): string {
  return `data:image/svg+xml;base64,${Buffer.from(CHIP_SVG).toString('base64')}`;
}

/** MCP protocol icon descriptors for the musterd adapter. */
export const MCP_ICONS = [
  {
    src: chipIconDataUri(),
    mimeType: 'image/svg+xml',
    sizes: ['any'] as string[],
  },
] as const;
