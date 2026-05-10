/** Shared MCP tool response type for our handlers */
export type McpToolResponse = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
};
