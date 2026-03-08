import { Mastra } from '@mastra/core'
import { weatherAgent } from './agents/weather-agent'
import { dataMigrationAgent } from './agents/data-migration-agent'
import { htmlReportParserTool } from './tools/html-report-parser-tool'

export const mastra = new Mastra({
    agents: { weatherAgent, dataMigrationAgent },
    tools: { htmlReportParserTool },
})
