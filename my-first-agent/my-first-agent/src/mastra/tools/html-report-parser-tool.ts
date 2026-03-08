import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// HTML parsing helpers (zero external dependencies)
// ─────────────────────────────────────────────────────────────────────────────

function stripTags(html: string): string {
    if (!html) return ''
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
}

function extractTables(html: string): string[] {
    const tables: string[] = []
    const tableRegex = /<table[\s\S]*?<\/table>/gi
    let match: RegExpExecArray | null
    while ((match = tableRegex.exec(html)) !== null) {
        tables.push(match[0])
    }
    return tables
}

/**
 * FIX 1: Only treat an <img> as a status indicator if its alt text is exactly
 * one of the known status keywords. This prevents "No Screenshot", "Logo" etc.
 * from being misclassified as status values.
 */
const STATUS_ALT_VALUES = new Set(['pass', 'fail', 'info', 'skip', 'warn', 'warning', 'error'])

function extractImgStatus(tdHtml: string): string | null {
    const imgAlt = tdHtml.match(/<img[^>]+alt="([^"]+)"/i)
    if (!imgAlt) return null
    const altLower = imgAlt[1].toLowerCase().trim()
    return STATUS_ALT_VALUES.has(altLower) ? imgAlt[1].toUpperCase() : null
}

type CellValue = string | number

function parseTableFull(tableHtml: string): { headers: string[]; rows: CellValue[][] } | null {
    // Extract headers
    const headers: string[] = []
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi
    let thMatch: RegExpExecArray | null
    while ((thMatch = thRegex.exec(tableHtml)) !== null) {
        headers.push(stripTags(thMatch[1]))
    }
    if (headers.length === 0) return null

    const rows: CellValue[][] = []
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch: RegExpExecArray | null

    while ((trMatch = trRegex.exec(tableHtml)) !== null) {
        const rowHtml = trMatch[1]
        if (/<th[\s>]/i.test(rowHtml)) continue

        const cells: CellValue[] = []
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
        let tdMatch: RegExpExecArray | null

        while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
            const cellHtml = tdMatch[1]

            // FIX 1: Only treat as status if alt text is a known keyword
            const imgStatus = extractImgStatus(cellHtml)
            if (imgStatus) {
                cells.push(imgStatus)
                continue
            }

            // FIX 2: For non-status <img> cells (e.g. screenshots), return the
            // image src path, or empty string if the cell has nothing else useful.
            const hasImg = /<img/i.test(cellHtml)
            if (hasImg) {
                // Try to get href from parent anchor (linked screenshot)
                const hrefMatch = cellHtml.match(/<a[^>]+href="([^"]+)"/i)
                cells.push(hrefMatch ? hrefMatch[1] : '')
                continue
            }

            // Prefer anchor text if present (linked cells in summary tables)
            const anchorText = cellHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/i)
            const rawText = anchorText ? stripTags(anchorText[1]) : stripTags(cellHtml)

            const asNum = Number(rawText)
            cells.push(!isNaN(asNum) && rawText !== '' ? asNum : rawText)
        }

        if (cells.length > 0) rows.push(cells)
    }

    return { headers, rows }
}

function findStepTable(tables: string[]): { headers: string[]; rows: CellValue[][] } | null {
    const STEP_HEADERS = ['s.no', 'step description', 'input value', 'expected value', 'actual value']
    for (const tableHtml of tables) {
        const parsed = parseTableFull(tableHtml)
        if (!parsed) continue
        const lowerH = parsed.headers.map(h => h.toLowerCase().trim())
        if (STEP_HEADERS.filter(h => lowerH.includes(h)).length >= 3) return parsed
    }
    return null
}

function findSummaryTable(tables: string[]): { headers: string[]; rows: CellValue[][] } | null {
    const SUMMARY_HEADERS = ['suite name', 'test case name', 'class name']
    for (const tableHtml of tables) {
        const parsed = parseTableFull(tableHtml)
        if (!parsed) continue
        const lowerH = parsed.headers.map(h => h.toLowerCase().trim())
        if (SUMMARY_HEADERS.filter(h => lowerH.includes(h)).length >= 2) return parsed
    }
    return null
}

/**
 * FIX 3: Smarter status filter.
 *
 * This report uses the following status icons:
 *   PASS  → step passed
 *   INFO  → informational / data-mismatch step (NOT a hard failure icon)
 *   FAIL  → hard exception / test-level failure
 *
 * Filter modes:
 *   'all'      → return everything
 *   'pass'     → Status = PASS
 *   'fail'     → Status = FAIL  OR  (Status = INFO AND Actual Value looks like a failure)
 *   'info'     → Status = INFO
 *   'skip'     → Status = SKIP
 *   'mismatch' → rows where Actual Value contains "Not Matches" or error patterns
 */
const MISMATCH_PATTERNS = [
    /not matches/i,
    /for input string/i,
    /data mismatch/i,
    /exception/i,
    /error/i,
    /null/i,
]

function isMismatchActualValue(val: CellValue): boolean {
    const s = String(val ?? '')
    return MISMATCH_PATTERNS.some(p => p.test(s))
}

function filterByStatus(
    table: { headers: string[]; rows: CellValue[][] },
    statusFilter: string,
): { headers: string[]; rows: CellValue[][] } {
    if (!statusFilter || statusFilter === 'all') return table

    const statusIdx = table.headers.findIndex(h => h.toLowerCase() === 'status')
    const actualIdx = table.headers.findIndex(h => h.toLowerCase() === 'actual value')

    if (statusIdx === -1) return table

    const filterLower = statusFilter.toLowerCase()

    const filtered = table.rows.filter(row => {
        const statusVal = String(row[statusIdx] ?? '').toUpperCase()
        const actualVal = actualIdx !== -1 ? row[actualIdx] : ''

        switch (filterLower) {
            case 'pass':
                return statusVal === 'PASS'

            case 'fail':
                // Hard FAIL icon OR INFO rows that contain a data mismatch / error in Actual Value
                return statusVal === 'FAIL' || (statusVal === 'INFO' && isMismatchActualValue(actualVal))

            case 'mismatch':
                // Only rows where the Actual Value contains a mismatch/error pattern
                return isMismatchActualValue(actualVal)

            case 'info':
                return statusVal === 'INFO'

            case 'skip':
                return statusVal === 'SKIP'

            default:
                // Generic: match status string
                return statusVal.includes(statusFilter.toUpperCase())
        }
    })

    return { headers: table.headers, rows: filtered }
}

function selectColumns(
    table: { headers: string[]; rows: CellValue[][] },
    columnNames: string[],
): { headers: string[]; rows: CellValue[][] } {
    if (!columnNames || columnNames.length === 0) return table
    const indices = columnNames
        .map(name => table.headers.findIndex(h => h.toLowerCase().trim() === name.toLowerCase().trim()))
        .filter(i => i !== -1)
    if (indices.length === 0) return table
    return {
        headers: indices.map(i => table.headers[i]),
        rows: table.rows.map(row => indices.map(i => row[i] ?? '')),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Column-name extractor (used by toModelOutput)
// ─────────────────────────────────────────────────────────────────────────────

function extractColumnName(stepDescription: CellValue): string | null {
    const s = String(stepDescription ?? '')
    const colonMatch = s.match(/column:([^\s,]+)/i)
    if (colonMatch) return colonMatch[1].trim()
    const spaceMatch = s.match(/,\s*[Cc]olumn\s+([^,\n]+?)\s*$/)
    if (spaceMatch) return spaceMatch[1].trim()
    return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Mastra Tool Definition
// ─────────────────────────────────────────────────────────────────────────────

export const htmlReportParserTool = createTool({
    id: 'html-report-parser',
    description:
        'Parses an automation test report HTML file (e.g. CurrentRun.html or a step-detail HTML) ' +
        'and returns its table data as structured JSON with headers and rows. ' +
        'Supports filtering rows by status: ' +
        '"pass" = only PASS rows, ' +
        '"fail" = hard FAIL rows + INFO rows with data mismatches/errors in Actual Value, ' +
        '"mismatch" = rows where Actual Value contains "Not Matches" or error patterns, ' +
        '"info" = INFO-status rows, ' +
        '"all" = everything (default). ' +
        'Optionally select specific columns to include.',

    inputSchema: z.object({
        filePath: z
            .string()
            .describe(
                'ABSOLUTE path to the HTML report file. Always use the full Windows path. ' +
                'Example: "C:\\Users\\aniru\\mastra setup\\workorder\\02Mar2026_171750\\Results\\Run_1\\LdpVsBIDataValidationTests\\OSDimRAvsGCPTests12_Iter1\\OSDimRAvsGCPTests12.html". ' +
                'Do NOT use relative paths — the server CWD may differ from the project root.'
            ),
        filter: z
            .enum(['all', 'pass', 'fail', 'info', 'skip', 'mismatch'])
            .optional()
            .default('all')
            .describe(
                'Filter rows by test status. ' +
                '"fail" captures both hard FAIL icon rows and INFO rows with data mismatches. ' +
                '"mismatch" returns only rows where Actual Value contains error/mismatch text. ' +
                'Defaults to "all".'
            ),
        columns: z
            .array(z.string())
            .optional()
            .describe(
                'List of column names to include in the output. ' +
                'Example: ["S.No", "Step Description", "Input Value", "Expected Value", "Actual Value"]. ' +
                'Omit to include all columns.',
            ),
        outputFormat: z
            .enum(['text', 'json'])
            .optional()
            .default('text')
            .describe(
                'Output format. ' +
                '"text" (default) = plain pipe-delimited text, grouped by column, easy to read. ' +
                '"json" = structured JSON with a "columns" array and a "groups" object, rows as single-line arrays.'
            ),
    }),

    outputSchema: z.object({
        result: z
            .string()
            .describe(
                'Parsed report output. Format depends on outputFormat input: ' +
                '"text" = plain pipe-delimited text grouped by column; ' +
                '"json" = structured JSON with columns array + groups object.'
            ),
        totalRows: z.number().describe('Total number of rows returned after filtering'),
        sourceFile: z.string().describe('Resolved absolute path of the parsed file'),
    }),

    execute: async ({ filePath, filter = 'all', columns, outputFormat = 'text' }) => {

        // ── Path resolution ───────────────────────────────────────────────────
        // Mastra's bundled server may run with a different process.cwd() than
        // the project root (e.g. src/mastra/public). We therefore:
        //   1. Try the path exactly as given (works if it's already absolute)
        //   2. Walk up from process.cwd() through parent directories as fallback
        // Always prefer absolute paths to avoid ambiguity.

        const normalised = filePath.replace(/\\/g, path.sep).replace(/\//g, path.sep)

        let resolvedPath: string | null = null

        // Candidate 1: treat as-is (works for absolute paths)
        if (path.isAbsolute(normalised) && fs.existsSync(normalised)) {
            resolvedPath = normalised
        }

        // Candidate 2+: walk up from cwd to find the file relative to each ancestor
        if (!resolvedPath) {
            let dir = process.cwd()
            for (let i = 0; i < 10; i++) {
                const candidate = path.resolve(dir, normalised)
                if (fs.existsSync(candidate)) {
                    resolvedPath = candidate
                    break
                }
                const parent = path.dirname(dir)
                if (parent === dir) break   // reached filesystem root
                dir = parent
            }
        }

        if (!resolvedPath) {
            throw new Error(
                `HTML file not found: "${filePath}". ` +
                `Server CWD is "${process.cwd()}". ` +
                `Please provide a full absolute path, e.g. ` +
                `"C:\\Users\\aniru\\mastra setup\\workorder\\...\\OSDimRAvsGCPTests12.html".`
            )
        }

        const html = fs.readFileSync(resolvedPath!, 'utf8')
        const tables = extractTables(html)

        if (tables.length === 0) {
            throw new Error('No <table> elements found in the HTML file.')
        }

        // Try step table first, then summary table, then largest table
        let result = findStepTable(tables)
        if (!result) result = findSummaryTable(tables)
        if (!result) {
            let largest: { headers: string[]; rows: CellValue[][] } | null = null
            for (const t of tables) {
                const p = parseTableFull(t)
                if (p && (!largest || p.rows.length > largest.rows.length)) largest = p
            }
            result = largest
        }

        if (!result || result.headers.length === 0) {
            throw new Error('Could not extract any table data from the HTML file.')
        }

        // Apply status filter
        result = filterByStatus(result, filter)

        // Apply column selection
        if (columns && columns.length > 0) {
            result = selectColumns(result, columns)
        }

        // Always strip noise columns — Time, Status, Screen shot add no analytical
        // value for migration debugging and inflate the token count.
        const STRIP_COLUMNS = ['time', 'status', 'screen shot', 'line no']
        const stripIndices = new Set(
            result.headers
                .map((h, i) => (STRIP_COLUMNS.includes(h.toLowerCase().trim()) ? i : -1))
                .filter(i => i !== -1)
        )
        if (stripIndices.size > 0) {
            const keepIndices = result.headers.map((_, i) => i).filter(i => !stripIndices.has(i))
            result = {
                headers: keepIndices.map(i => result!.headers[i]),
                rows: result.rows.map(row => keepIndices.map(i => row[i] ?? '')),
            }
        }

        // ── Group rows by DB column name + build plain text output ────────────
        const sdIdx = result.headers.findIndex(h => h.toLowerCase() === 'step description')
        const groups: Record<string, CellValue[][]> = {}
        for (const row of result.rows) {
            const colName = sdIdx !== -1 ? (extractColumnName(row[sdIdx]) ?? '__unknown__') : '__unknown__'
            if (!groups[colName]) groups[colName] = []
            groups[colName].push(row)
        }

        let resultStr: string

        if (outputFormat === 'json') {
            // ── Structured JSON output ────────────────────────────────────────
            const jsonLines: string[] = []
            jsonLines.push('{')
            jsonLines.push(`  "columns": ${JSON.stringify(result.headers)},`)
            jsonLines.push('  "groups": {')
            const jsonKeys = Object.keys(groups).filter(k => k !== '__unknown__')
            jsonKeys.forEach((key, ki) => {
                const isLast = ki === jsonKeys.length - 1
                jsonLines.push(`    ${JSON.stringify(key)}: [`)
                groups[key].forEach((row, ri) => {
                    const comma = ri < groups[key].length - 1 ? ',' : ''
                    const rowStr = '[' + row.map(v => JSON.stringify(v)).join(', ') + ']'
                    jsonLines.push(`      ${rowStr}${comma}`)
                })
                jsonLines.push(`    ]${isLast ? '' : ','}`)
                if (!isLast) jsonLines.push('')
            })
            jsonLines.push('  },')
            jsonLines.push(`  "totalRows": ${result.rows.length},`)
            jsonLines.push(`  "sourceFile": ${JSON.stringify(resolvedPath)}`)
            jsonLines.push('}')
            resultStr = jsonLines.join('\n')
        } else {
            // ── Plain text output (default) ───────────────────────────────────
            const textLines: string[] = []
            textLines.push(`Source: ${resolvedPath}`)
            textLines.push(`Columns: ${result.headers.join(' | ')}`)
            textLines.push(`Total rows: ${result.rows.length}`)
            for (const key of Object.keys(groups)) {
                if (key === '__unknown__') continue
                const groupRows = groups[key]
                textLines.push('')
                textLines.push(`=== ${key} (${groupRows.length} ${groupRows.length === 1 ? 'row' : 'rows'}) ===`)
                for (const row of groupRows) {
                    textLines.push(row.map(v => String(v ?? '')).join(' | '))
                }
            }
            resultStr = textLines.join('\n')
        }

        return {
            result: resultStr,
            totalRows: result.rows.length,
            sourceFile: resolvedPath!,
        }
    },

    // Pass the compact string directly to the LLM — no re-formatting
    toModelOutput: (output) => ({
        type: 'text' as const,
        value: output.result,
    }),
})
