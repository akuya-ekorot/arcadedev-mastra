import { Mastra } from '@mastra/core';
import { githubAgent } from './agents/github';

export const mastra = new Mastra({
  agents: { githubAgent }
})
