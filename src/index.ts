#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logger } from './util/logger.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  logger.info('Appium Flutter MCP server starting...');

  await server.connect(transport);

  logger.info('Appium Flutter MCP server running on stdio');
}

main().catch((error) => {
  logger.error('Server failed to start', { error: String(error) });
  process.exit(1);
});
