# RA-GCP Parity Agent — Build Specification

**Version:** 2.0  
**Date:** 2026-03-08  
**Purpose:** Everything needed to BUILD the AI agent that replaces manual mismatch investigation between RA (SQL Server/BI) and GCP (BigQuery).

---

## 1. Purpose

Build an AI agent that **autonomously** performs the entire parity investigation lifecycle:

1. **Sources** lineage code, schemas, and metadata from both RA and GCP
2. **Compiles** them in the correct dependency order
3. **Compares** code logic side-by-side per column
4. **Generates and executes** diagnostic SQL on both platforms
5. **Interprets** results, classifies root causes
6. **Proposes** code fixes with before/after diffs
7. **Tests** fixes in QA, verifies with parity queries
8. **Produces** defect reports, lineage docs, and developer messages
9. **Pushes** approved code via PR and triggers deployment

The agent replaces **you** — the human doing the prompting, sourcing, querying, interpreting, and reporting.

---

## 2. What the Agent Replaces — The Manual Workflow Today

Below is the exact sequence of manual steps performed today, derived from the WorkOrder and Invoice investigations. **Every numbered step becomes an automated agent action.**

### PHASE A — INTAKE (today: ~30 min, agent: seconds)

**What you do manually:**
1. Receive parity test HTML/CSV report showing which columns mismatch between RA and GCP for a given table.
2. Open the report, scan the column names and sample rows.
3. Mentally classify which mismatches are format-only (datetime rendering, string encoding) vs. real defects.
4. Decide which columns need investigation and in what order.

**What the agent does instead:**
1. **Trigger:** Parity test framework calls agent webhook (or agent polls for new test results).
2. **Parse report:** Agent reads the HTML/CSV, extracts: table name, list of mismatched columns, sample key values (PMCID, PropertyID, EntityID), diff counts per column.
3. **Auto-classify format mismatches:** Agent applies format-ignore rules from memory (e.g., datetime rendering, trailing whitespace). These are logged and skipped.
4. **Order remaining columns:** Agent sorts by dependency (e.g., `actualcompletedby` before `actualcompletedbyemployee` because the employee name depends on the ID join). Dependency ordering rules come from the nomenclature mapping.

**Agent function needed:** `intake_parity_report(report_path) → List[ColumnInvestigation]`

---

### PHASE B — LINEAGE SOURCING (today: 4-8 hours, agent: minutes)

This is the **biggest bottleneck** you currently face. Here's exactly what happens manually and what the agent automates:

#### B.1 — GCP Side Sourcing

**What you do manually:**
1. Navigate to the Azure DevOps / Git repo: `ai_data_centralization/bigquery/datasets/cl_unified_pms/stored_procedures/`
2. Open `sp_<TableName>_upsert.sql`
3. Read through it. Identify all referenced tables: `lz_onesite.*` sources, `cl_unified_pms.*` dimension lookups, temp tables, UDFs.
4. For each `cl_unified_pms` dependency (e.g., `cl_unified_pms.Employee`, `cl_unified_pms.CodeLookup`), open *their* `sp_*_upsert.sql` to understand how they're populated.
5. Mentally compile the lineage: source → temp → target, with all join conditions noted.

**What the agent does instead:**
1. **Fetch SP code from repo:** Call Azure DevOps REST API → `GET /repos/{repoId}/items?path=/bigquery/datasets/cl_unified_pms/stored_procedures/sp_{table}_upsert.sql`
2. **Parse the SQL:** Extract every `FROM`, `JOIN`, `LEFT JOIN`, `CREATE TEMP TABLE`, `UPDATE`, `MERGE` statement. Build a structured representation:
   ```
   {
     temp_tables: [{name, columns, source_tables, join_conditions}],
     updates: [{target_temp, set_columns, from_tables, where_conditions}],
     merge: {target, source, on_keys, matched_updates, not_matched_inserts}
   }
   ```
3. **Identify dependencies:** For each `cl_unified_pms.*` table referenced in joins, fetch its SP file too. Recursively parse to understand how lookup tables (Employee, CodeLookup, Property, etc.) are populated.
4. **Fetch schema:** Query BigQuery `INFORMATION_SCHEMA.COLUMNS` for the target table to get column names and data types.
5. **Store in investigation context:** The parsed lineage tree becomes the GCP side of the investigation.

**Agent functions needed:**
- `fetch_gcp_sp_code(table_name) → str` (via Git/ADO API)
- `parse_sql_procedure(sql_code) → ProcedureAST` (SQL parser)
- `fetch_bq_schema(project, dataset, table) → List[ColumnDef]` (via BigQuery API)
- `build_gcp_lineage(table_name) → LineageTree`

#### B.2 — RA Side Sourcing

**What you do manually (this is the painful part):**
1. Connect to RA SQL Server via SSMS.
2. Run `sp_helptext 'Facilities.asp_Merge<Table>IntoStaging'` — copy the output into a text file.
3. Read the SP to identify it references `Facilities.StagingSource<Table>`. Run `sp_helptext 'Facilities.asp_MergeSource<Table>IntoSource'` — copy that too.
4. Check if there are more procedures (like `asp_MergeSource<Table>OnHoldIntoSource`). Run those too.
5. Identify all referenced tables: `Facilities.StagingSource*`, `Facilities.Source*`, `dbo.Dim*`, `dbo.DimCodeLookup`, `#Employee` temp table.
6. Manually trace the column lineage: which `StagingWorkOrder` column feeds which `StagingDimWorkOrder` column feeds which `dbo.DimWorkOrder` column.
7. Note the post-INSERT UPDATE steps (Step 10: encryption, Step 11: WOActualWorkMinutes, Step 12: MRActualWorkMinutes, Step 12.2: WOWorkGroup, etc.).

**What the agent does instead:**
1. **Option A — BI Code Repo (preferred):** If RA/BI team has a Git/TFS repo, agent fetches SP files the same way as GCP side. **This is the ideal path — you noted this is what would make RA sourcing as efficient as GCP.**
2. **Option B — sp_helptext extraction:** Agent connects to SQL Server via `pyodbc`, executes:
   ```sql
   EXEC sp_helptext 'Facilities.asp_Merge<Table>IntoStaging'
   EXEC sp_helptext 'Facilities.asp_MergeSource<Table>IntoSource'
   -- any additional related procs
   ```
   Concatenates the output lines into complete SQL text.
3. **Parse the SQL:** Same structured extraction as GCP side, adapted for SQL Server syntax (CTEs instead of QUALIFY, `#temp` tables, `ISNULL` instead of `IFNULL`, etc.).
4. **Identify the UPDATE chain:** RA procs have numbered steps (Step 10, 11, 12, 12.1, 12.2, etc.) that modify the target table AFTER the initial MERGE. The agent must identify all post-merge UPDATEs and map which columns they touch.
5. **Fetch schema:** Query `INFORMATION_SCHEMA.COLUMNS` on SQL Server for `dbo.DimWorkOrder` (or whichever target).
6. **Store in investigation context.**

**Agent functions needed:**
- `fetch_ra_sp_code(proc_name) → str` (via repo API or `sp_helptext`)
- `discover_ra_proc_chain(table_name) → List[str]` (identifies all procs in the lineage chain)
- `parse_sql_server_procedure(sql_code) → ProcedureAST`
- `fetch_ra_schema(table_name) → List[ColumnDef]`
- `build_ra_lineage(table_name) → LineageTree`

**Critical note:** The agent needs to know the proc naming convention to discover the chain:
- Main proc: `Facilities.asp_Merge<Table>IntoStaging`
- Source proc: `Facilities.asp_MergeSource<Table>IntoSource`
- Possible extras: `Facilities.asp_MergeSource<Table>OnHoldIntoSource`, etc.
- The agent should also query `sys.procedures` filtered by `Facilities%` and the table name to discover any procs it doesn't know about.

#### B.3 — Schema and Nomenclature Alignment

**What you do manually:**
1. Map GCP column names to RA column names (e.g., `RsPMCID` ↔ `osl_PMCID`, `RsWorkOrderId` ↔ `osl_WOID`).
2. Map GCP filter expressions to RA equivalents (e.g., `DeletedInd = FALSE` ↔ `IsDeleted <> 'Y'`).
3. Map GCP SQL functions to RA equivalents (e.g., `TIMESTAMP_DIFF(end, start, MINUTE)` ↔ `DATEDIFF_BIG(MINUTE, start, end)`).

**What the agent does instead:**
1. **Load nomenclature mapping from memory:** Agent has a persisted mapping document (see Section 7) that maps column names, filter expressions, and SQL functions between the two platforms.
2. **Auto-align columns:** For each column in the parity report, agent looks up both the GCP and RA column names from the mapping.
3. **If unmapped column found:** Agent attempts heuristic matching (strip `Rs`/`osl_` prefixes, match on stem) and flags for human confirmation if uncertain.

**Agent function needed:** `align_columns(gcp_columns, ra_columns, mapping) → List[ColumnPair]`

---

### PHASE C — CODE COMPARISON (today: 1-2 hours, agent: seconds)

**What you do manually:**
1. For each mismatched column, find the GCP code that produces it and the RA code that produces it.
2. Place them side by side.
3. Identify differences: different source column, different join conditions, extra/missing filters, different calculation formula, different argument order.

**What the agent does instead:**
1. **Extract per-column lineage:** From the parsed ASTs, agent traces each mismatched column backward:
   - GCP: Which SELECT expression produces this column? Which JOINs feed it? Which UPDATEs modify it post-creation?
   - RA: Same trace through the INSERT → UPDATE → MERGE chain.
2. **Normalize and diff:** Agent translates both sides to a canonical intermediate representation (handling `ISNULL↔COALESCE`, `IsDeleted<>'Y'↔DeletedInd=FALSE`, etc.) then diffs.
3. **Classify differences:** Each diff is classified using the mismatch taxonomy:
   - **Extra filter:** One side has a filter the other doesn't (e.g., `UserDisableInd = 0`)
   - **Missing scope key:** A join is missing a key column (e.g., `cdspmcid` not in ON clause)
   - **Wrong source:** Column pulls from wrong field (e.g., `E.EmployeeNm` instead of `wo.woactualcompleteby`)
   - **Arg order:** Function arguments in wrong order (e.g., `DATE_DIFF` end/start swapped)
   - **Hardcoded value:** One side has `NULL` or a literal where the other has a real column reference
   - **Missing post-step:** One side has a post-merge UPDATE that the other doesn't
   - **Format only:** Same data, different CAST/rendering

**Agent function needed:** `compare_column_lineage(gcp_lineage, ra_lineage, column_pair) → DiffClassification`

---

### PHASE D — DIAGNOSTIC QUERY GENERATION AND EXECUTION (today: 2-4 hours, agent: minutes)

This is where the manual process involves the most back-and-forth prompting. Here's the exact pattern:

**What you do manually:**
1. For each column with a code difference, you write a diagnostic query for GCP QA:
   ```sql
   SELECT <mismatched_column>, <key_columns>, <join_input_columns>
   FROM `ai-data-platform-qa-5201.cl_unified_pms.<Table>`
   WHERE <key_columns> IN (<sample values from parity report>)
   ```
2. You write a matching query for RA:
   ```sql
   SELECT <equivalent_columns_with_osl_prefix>
   FROM dbo.Dim<Table>
   WHERE <osl_key_columns> IN (<same sample values>)
   ```
3. You write a source-of-truth query against the lz/staging tables:
   ```sql
   SELECT <raw_source_columns>
   FROM `lz_onesite.OneSiteProperty_dbo_<SourceTable>`
   WHERE <source_keys> IN (<same values>)
   ```
4. You run all three, compare results, confirm or revise your hypothesis.
5. If not confirmed, you write deeper queries (check intermediate temp table logic, check join fanout, check dedup behavior).

**What the agent does instead:**
1. **Generate diagnostic queries automatically:** For each classified diff, agent generates a set of queries:

   **Query Type 1 — Target state check (both sides):**
   ```python
   def generate_target_query(platform, table, columns, key_values):
       # GCP: SELECT ActualCompletedBy, RsWorkOrderId, RsPMCID, RsPropertyID
       #      FROM `ai-data-platform-qa-5201.cl_unified_pms.WorkOrder`
       #      WHERE RsWorkOrderId = 68 AND RsPMCID = 2507719 AND RsPropertyID = 3282497
       # RA:  SELECT ActualCompletedBy, osl_WOID, osl_PMCID, osl_PropertyID
       #      FROM dbo.DimWorkOrder
       #      WHERE osl_WOID = 68 AND osl_PMCID = 2507719 AND osl_PropertyID = 3282497
   ```

   **Query Type 2 — Source-of-truth check (lz raw):**
   ```python
   def generate_source_query(table, raw_column, key_values):
       # SELECT woactualcompleteby, woid, cdspmcid, cdspropertyid
       # FROM `lz_onesite.OneSiteProperty_dbo_WorkOrder`
       # WHERE woid = 68 AND cdspmcid = 2507719 AND cdspropertyid = 3282497
   ```

   **Query Type 3 — Join verification (check what the lookup table returns):**
   ```python
   def generate_join_check_query(platform, lookup_table, join_keys, filter_conditions):
       # SELECT EmployeeNm, RsEmployeeNb, RsPMCID, DeletedInd, UserDisableInd
       # FROM `cl_unified_pms.Employee`
       # WHERE RsEmployeeNb = '44347008' AND RsPMCID = 2507719
       #   -- Shows whether UserDisableInd=0 filter would exclude this employee
   ```

   **Query Type 4 — Fanout/contamination check:**
   ```python
   def generate_fanout_query(lookup_table, join_key_value):
       # SELECT user_id, cdspmcid, user_first, user_last
       # FROM `lz_onesite.OneSiteSecurity_dbo_USER_PROFILE`
       # WHERE user_id = 76813910
       # ORDER BY cdspmcid
       #   -- Shows how many PMCs reuse this user_id (cross-PMC check)
   ```

   **Query Type 5 — Parity count (how many rows affected):**
   ```python
   def generate_parity_count_query(table, column, key_scope):
       # SELECT COUNT(*) AS total, COUNTIF(qa.col IS DISTINCT FROM prod.col) AS diffs
       # FROM qa_table qa JOIN prod_table prod ON keys
       # WHERE scope_filter
   ```

2. **Execute all queries:** Agent sends queries to BigQuery (via Python client) and SQL Server (via pyodbc) in parallel where possible.

3. **Interpret results:** Agent compares the three result sets:
   - If GCP target ≠ lz source AND RA target = lz source → **GCP transformation bug**
   - If GCP target = lz source AND RA target ≠ lz source → **RA transformation bug**
   - If both ≠ lz differently → **Both have bugs**
   - If GCP = RA but both ≠ lz → **Shared upstream issue**
   - If diff is only in a lookup-derived column → run **join verification query** to check filter/scope

4. **Iterate if needed:** If results are inconclusive, agent generates deeper queries:
   - Check the intermediate temp table logic (e.g., does the QUALIFY pick the right row?)
   - Check for join fanout (e.g., does a user_id map to multiple PMCs?)
   - Check ETL timing (e.g., does `cdssourcelogtime` fall within the incremental window?)

**Agent functions needed:**
- `generate_diagnostic_queries(diff_classification, sample_keys) → List[Query]`
- `execute_bq_query(query) → ResultSet`
- `execute_ra_query(query) → ResultSet`
- `interpret_results(gcp_result, ra_result, source_result, diff_classification) → RootCauseConfirmation`
- `generate_deeper_queries(inconclusive_result) → List[Query]`

---

### PHASE E — FIX PROPOSAL (today: 1-2 hours, agent: seconds)

**What you do manually:**
1. Based on confirmed root cause, write the minimal code change (before/after SQL).
2. Write a verification query that should return 0 diffs after the fix.
3. Assess risk: does this column feed downstream calculations?
4. Draft a developer message explaining the issue and proposed fix.

**What the agent does instead:**
1. **Generate code fix:** Based on the diff classification:

   | Diff Type | Fix Template |
   |-----------|-------------|
   | Extra filter | Remove the extra filter line from the JOIN |
   | Missing scope key | Add the scoping column to the JOIN ON clause |
   | Wrong source column | Replace the SELECT expression |
   | Arg order | Swap the arguments |
   | Hardcoded NULL | Replace with actual source column reference |
   | Missing post-step | Add the equivalent UPDATE step |

   ```python
   def generate_fix(diff_classification, gcp_sp_code) -> CodeChange:
       # Returns: {file_path, line_range, before_code, after_code}
   ```

2. **Generate verification query:** A parity query scoped to the affected column and sample keys that should return 0 diffs after the fix is applied.

3. **Assess downstream impact:** Query BigQuery `INFORMATION_SCHEMA` and scan other SP files to find any tables/views that reference the column being fixed.

4. **Draft developer message:** Using a template, populate with: ticket reference, root cause summary, before/after code, verification query, impact assessment.

**Agent functions needed:**
- `generate_code_fix(diff, sp_code) → CodeChange`
- `generate_verification_query(table, column, sample_keys) → Query`
- `assess_downstream_impact(table, column) → ImpactReport`
- `draft_developer_message(root_cause, fix, impact) → str`

---

### PHASE F — TEST FIX IN QA (today: 1-2 hours, agent: minutes)

**What you do manually:**
1. Deploy the fixed procedure to QA scratch (e.g., `scratch.sp_<Table>_test_upsert`).
2. Run the procedure with a full reload date range.
3. Run the parity count query against QA output vs PROD.
4. Confirm diffs drop to 0 for the fixed columns.
5. Check that no other columns regressed.

**What the agent does instead (this is the part that proves the fix works):**
1. **Deploy to QA scratch:** Agent modifies the SP code to write to a scratch table, then executes `CREATE OR REPLACE PROCEDURE scratch.sp_<Table>_test_upsert(...)` on QA BigQuery.
2. **Execute full reload:** `CALL scratch.sp_<Table>_test_upsert('2015-01-01', CURRENT_TIMESTAMP)`
3. **Run parity queries:**
   - **Fixed columns:** `COUNTIF(qa.col IS DISTINCT FROM prod.col)` should be 0 (or near 0, accounting for ETL timing).
   - **All other columns:** Confirm no regressions — diff counts should be same or better than before.
4. **Log results:** Store the before/after diff counts as evidence.
5. **If test fails:** Agent analyzes the remaining diffs, revises the fix, re-tests.

**Agent functions needed:**
- `deploy_to_qa_scratch(sp_code, table_name) → bool`
- `execute_qa_reload(proc_name, begin_date) → RunResult`
- `run_parity_verification(qa_table, prod_table, columns, key_scope) → ParityResult`
- `check_regression(before_diffs, after_diffs) → RegressionReport`

---

### PHASE G — PUSH CODE AND DEPLOY (today: manual PR, agent: automated PR)

**What you do manually:**
1. Commit the fixed SP code to the repo.
2. Create a pull request with the defect report as description.
3. Wait for review and approval.
4. After approval, deploy to PROD BigQuery.
5. Trigger a full reload.
6. Re-run parity test to confirm.

**What the agent does instead:**
1. **Create a branch:** `fix/<table>-parity-<date>`
2. **Commit the changed file:** The modified `sp_<Table>_upsert.sql`
3. **Create PR:** With auto-generated description containing: root cause summary, before/after diff, QA test results, verification query, impact assessment.
4. **GATE: Wait for human approval** on the PR.
5. **After approval:** Agent deploys procedure to PROD BigQuery (executes CREATE OR REPLACE).
6. **Trigger full reload:** `CALL cl_unified_pms.sp_<Table>_upsert('2015-01-01', CURRENT_TIMESTAMP)`
7. **Run final parity verification.**
8. **Generate defect report:** Complete document following the template (like `Invoice_Parity_Defect_Report.md`).
9. **Close ticket.**

**Agent functions needed:**
- `create_branch_and_commit(file_path, new_code, branch_name, commit_msg) → str`
- `create_pull_request(branch, title, description) → PR_URL`
- `deploy_to_prod(sp_code) → bool` (REQUIRES HUMAN APPROVAL)
- `trigger_full_reload(proc_name) → RunResult` (REQUIRES HUMAN APPROVAL)
- `generate_defect_report(investigation_context) → MarkdownDocument`

---

## 3. Exact Prompts the Agent Replaces

Today, you prompt an LLM in a conversational loop. Here is each prompt type and what replaces it:

### Prompt 1 — Lineage Intake

**What you type today:**
> "I am now inputting the lineage of the GCP side code. This is the table name: cl_unified_pms.WorkOrder. This is the stored procedure that it is based on: [paste 500+ lines of SQL]"

**Agent replacement:** `fetch_gcp_sp_code("WorkOrder")` → automatic. No paste needed. Agent reads from repo.

### Prompt 2 — RA Lineage Intake

**What you type today:**
> "I am now inputting the lineage of the RA side. [paste sp_helptext output, metadata tables, schema info]"

**Agent replacement:** `fetch_ra_sp_code("Facilities.asp_MergeWorkOrderIntoStaging")` → automatic. Agent runs `sp_helptext` itself or reads from BI repo.

### Prompt 3 — Investigation Kickoff

**What you type today:**
> "Let us go one by one and try and get into the debugging/querying phase to start with specific queries for each mismatched column."

**Agent replacement:** The `compare_column_lineage()` function runs automatically for each column. No prompt needed.

### Prompt 4 — Query Results Intake

**What you type today:**
> "Debugging Queries Query 1 — GCP QA: Current state of ActualCompletedBy in the WorkOrder table. [paste results]"

**Agent replacement:** Agent runs the query itself via `execute_bq_query()` and processes the `ResultSet` programmatically. No copy-paste.

### Prompt 5 — Result Interpretation Request

**What you type today:**
> "Here are the results. What does this tell us? What should we check next?"

**Agent replacement:** `interpret_results()` function compares GCP result vs RA result vs lz source result, applies the mismatch taxonomy, and determines next action automatically.

### Prompt 6 — Fix Confirmation

**What you type today:**
> "Confirmed. Draft the developer message and move to the next column."

**Agent replacement:** If confidence ≥ threshold, agent auto-confirms, generates fix, and proceeds. If confidence < threshold, agent pauses for human review (see Section 5 — Human-in-the-Loop).

### Prompt 7 — Developer Message

**What you type today:**
> "Draft a developer confirmation message for this fix."

**Agent replacement:** `draft_developer_message()` generates this from the investigation context automatically.

### Prompt 8 — Context Continuation

**What you type today:**
> "I am running out of context in this chat. Let us branch into a new chat based on the above context."

**Agent replacement:** Agent has persistent memory (Section 7). No context window limit — investigation state is stored in a database, not in a chat window.

---

## 4. Agent Inputs and Outputs

### 4.1 Inputs the agent consumes

| Input | How the agent gets it | Used in which phase |
|-------|----------------------|-------------------|
| Parity test report (column diffs + sample rows) | Webhook trigger or poll from test framework | A — Intake |
| GCP stored procedure SQL code | Azure DevOps REST API: `GET /repos/{id}/items?path=...` | B — Lineage Sourcing |
| RA stored procedure SQL code | `sp_helptext` via pyodbc **OR** BI code repo API | B — Lineage Sourcing |
| GCP table schema | `SELECT * FROM ai-data-platform-qa-5201.cl_unified_pms.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '<Table>'` | B — Schema alignment |
| RA table schema | `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'DimWorkOrder'` on SQL Server | B — Schema alignment |
| GCP QA table data | BigQuery query execution on `ai-data-platform-qa-5201.cl_unified_pms.*` | D — Diagnostic queries |
| GCP PROD table data | BigQuery query execution on `ai-data-platform-prod.cl_unified_pms.*` | D — Diagnostic queries |
| RA table data | SQL Server query execution on `dbo.Dim*` tables | D — Diagnostic queries |
| lz source data | BigQuery query on `ai-data-platform-prod.lz_onesite.*` | D — Source-of-truth check |
| ETL load logs | BigQuery query on `cl_unified_pms.etl_load_log` | D — Timing analysis |
| Nomenclature mapping | Agent memory (persisted YAML/JSON) | B, C — Column alignment |
| Known patterns library | Agent memory (persisted) | C — Pattern matching |
| Repository commit history | ADO API: `GET /repos/{id}/commits?searchCriteria.itemPath=...` | G — Change tracking |

### 4.2 Outputs the agent produces

| Output | Format | Destination | Produced in which phase |
|--------|--------|-------------|------------------------|
| Column mismatch classifications | Structured JSON | Internal state + audit log | A, C |
| Diagnostic SQL queries (auto-generated) | SQL strings | Executed against BQ + SQL Server | D |
| Query result interpretations | Structured analysis | Internal state + audit log | D |
| Root cause confirmations with evidence | JSON + Markdown | Investigation report | D |
| Code fix diffs (before/after) | Unified diff | PR description + defect report | E |
| Verification queries | SQL strings | Executed against QA + PROD | E, F |
| QA test results | Parity counts | Defect report evidence | F |
| Developer confirmation messages | Markdown | Slack/Teams/ADO | E |
| Pull request | ADO PR | Azure DevOps | G |
| Defect report (full document like `Invoice_Parity_Defect_Report.md`) | Markdown | File output + ADO attachment | G |
| Lineage document | Markdown | File output | B |
| Audit trail (every action logged) | JSON | BigQuery audit dataset | All phases |
| Jira/ADO ticket updates | API calls | Ticket system | A, G |

---

## 5. Human-in-the-Loop — Exactly Where the Agent Pauses

The agent runs autonomously EXCEPT at these gates:

| Gate | When it triggers | What the agent shows the human | What the human does |
|------|-----------------|-------------------------------|-------------------|
| **GATE 1: Ambiguous classification** | Agent confidence < 80% on a root cause | All evidence collected, alternative hypotheses ranked | Confirm one hypothesis or request more queries |
| **GATE 2: Business rule decision** | Agent finds a case where GCP and RA intentionally differ (e.g., store "0" vs NULL for empty employee) | Both options with impact counts | Pick option A or B |
| **GATE 3: PR approval** | Code fix ready, QA test passed | PR with: root cause, diff, QA results, verification query | Approve or request changes |
| **GATE 4: PROD deployment** | PR approved | Deployment command ready | Approve to execute |
| **GATE 5: Full reload trigger** | PROD procedure updated | Reload command ready, estimated runtime | Approve to execute |
| **GATE 6: New pattern discovered** | Agent encounters a mismatch type not in its pattern library | Raw evidence, proposed pattern definition | Approve pattern for memory |

### How the agent requests human input

Agent sends a structured notification (Slack/Teams/email) with:
```
[PARITY AGENT] Human Decision Required
Table: cl_unified_pms.WorkOrder
Column: ActualCompletedBy
Gate: GATE 2 — Business rule decision

CONTEXT: Source has woactualcompleteby = 0 for ~2,400 rows (no employee assigned).
OPTION A: Store "0" (matches RA behavior)  
OPTION B: Store NULL (semantic "no one")

EVIDENCE: [link to query results]
RECOMMENDATION: Option A (parity with RA source of truth)

Reply: A / B / NEED_MORE_INFO
```

---

## 6. Permissions and Access — What the Agent Needs to Connect To

### 6.1 Database connections

| System | Connection | Permission | Service Account |
|--------|-----------|------------|-----------------|
| BigQuery QA | `google-cloud-bigquery` Python client | `roles/bigquery.dataViewer` on `ai-data-platform-qa-5201` datasets: `cl_unified_pms`, `scratch`, `lz_onesite` | `svc-parity-agent@ai-data-platform-qa-5201.iam.gserviceaccount.com` |
| BigQuery QA scratch | Same client | `roles/bigquery.dataEditor` on `scratch` dataset only | Same SA |
| BigQuery PROD | Same client | `roles/bigquery.dataViewer` on `ai-data-platform-prod` datasets: `cl_unified_pms`, `lz_onesite` | `svc-parity-agent@ai-data-platform-prod.iam.gserviceaccount.com` |
| BigQuery PROD (deploy) | Same client | `roles/bigquery.dataEditor` on `cl_unified_pms` (procedures + data) | Separate SA with elevated perms, gated by approval |
| SQL Server (RA) | `pyodbc` via VPN/Private Endpoint | `db_datareader` + `EXECUTE` on `sp_helptext` + read on `INFORMATION_SCHEMA` | `svc_parity_agent` SQL login |

### 6.2 Code repository

| System | Connection | Permission |
|--------|-----------|------------|
| Azure DevOps Git (GCP code) | REST API with PAT | Read on repo |
| Azure DevOps Git (BI code, if available) | REST API with PAT | Read on repo |
| Azure DevOps Git (for PRs) | REST API with PAT | Create branch, commit, create PR |

### 6.3 Ticketing and notifications

| System | Connection | Permission |
|--------|-----------|------------|
| Azure DevOps Boards / Jira | REST API | Create and update work items |
| Slack / Teams | Incoming webhook | Send messages (for human gates) |

### 6.4 Network constraints

- BigQuery: VPC with Private Google Access (no public internet egress)
- SQL Server: VPN or Azure Private Endpoint (no public exposure)
- All queries logged to Cloud Audit Logs automatically

---

## 7. Memory and Standardization — What the Agent Persists

### 7.1 Nomenclature mapping (critical — load on every run)

A persisted YAML/JSON document mapping between RA and GCP:

```yaml
tables:
  WorkOrder:
    gcp: cl_unified_pms.WorkOrder
    ra: dbo.DimWorkOrder
    gcp_proc: cl_unified_pms.sp_WorkOrder_upsert
    ra_procs:
      - Facilities.asp_MergeWorkOrderIntoStaging
      - Facilities.asp_MergeSourceWorkOrderIntoSource
      - Facilities.asp_MergeSourceWorkOrderOnHoldIntoSource
    keys:
      gcp: [RsPMCID, RsPropertyID, RsWorkOrderId]
      ra: [osl_PMCID, osl_PropertyID, osl_WOID]
    lz_source: lz_onesite.OneSiteProperty_dbo_WorkOrder
    lz_keys: [cdspmcid, cdspropertyid, woid]

columns:
  - gcp: RsPMCID
    ra: osl_PMCID
    lz: cdspmcid
  - gcp: RsPropertyID
    ra: osl_PropertyID
    lz: cdspropertyid
  - gcp: RsWorkOrderId
    ra: osl_WOID
    lz: woid
  - gcp: RsTimeRangeId
    ra: osl_TRID
    lz: trid
  - gcp: ActualCompletedBy
    ra: ActualCompletedBy
    lz: woactualcompleteby
  - gcp: DeletedInd  # BOOL
    ra: IsDeleted    # CHAR 'Y'/'N'

filters:
  deleted_not:
    gcp: "DeletedInd = FALSE"
    ra: "IsDeleted <> 'Y'"
  extract_not_deleted:
    gcp: "CDsExtractType <> 'Delete'"
    ra: "CDSExtractType <> 'D'"

functions:
  date_diff:
    gcp: "DATE_DIFF(end, start, part)"
    ra: "DATEDIFF(part, start, end)"
    note: "ARGUMENT ORDER DIFFERS — common bug source"
  timestamp_diff:
    gcp: "TIMESTAMP_DIFF(end, start, MINUTE)"
    ra: "DATEDIFF_BIG(MINUTE, start, end)"
  null_replace:
    gcp: "IFNULL(x, y) or COALESCE(x, y)"
    ra: "ISNULL(x, y) or COALESCE(x, y)"
  initcap:
    gcp: "INITCAP(x)"
    ra: "[dbo].[InitCap](x)"
  dedup:
    gcp: "QUALIFY ROW_NUMBER() OVER (...) = 1"
    ra: "; WITH CTE AS (SELECT ..., ROW_NUMBER() OVER (...) AS rn) ... WHERE rn = 1"
```

**This mapping must be extensible.** When the agent investigates a new table, it adds the table-level and column-level mappings to this file automatically.

### 7.2 Known patterns library (grows with each investigation)

```yaml
patterns:
  - id: PAT-001
    name: "Extra UserDisableInd filter in GCP"
    signature: "GCP Employee join contains UserDisableInd = 0; RA does not"
    detection: "diff_type == 'extra_filter' AND filter_column == 'UserDisableInd'"
    resolution: "Remove UserDisableInd = 0 from GCP join"
    confidence: 0.95
    first_seen: "WorkOrder.ActualCompletedByEmployee"
    
  - id: PAT-002
    name: "Cross-PMC contamination in user/employee join"
    signature: "Join on user_id/employee_id without cdspmcid/osl_PMCID scope"
    detection: "join_keys does not contain PMCID column"
    resolution: "Add cdspmcid/PMCID to the join ON clause"
    confidence: 0.99
    first_seen: "Invoice.ApproverNm"
    
  - id: PAT-003
    name: "DATE_DIFF/DATEDIFF argument order inversion"
    signature: "GCP DATE_DIFF has start before end (should be end, start)"
    detection: "function_name in (DATE_DIFF, TIMESTAMP_DIFF) AND arg_order == (start, end)"
    resolution: "Swap arguments to match: DATE_DIFF(end, start, part)"
    confidence: 0.90
    first_seen: "WorkOrder.MRActualWorkMinutes"
    
  - id: PAT-004
    name: "Hardcoded NULL replacing real column"
    signature: "GCP has CAST(NULL AS type) or literal NULL for a column that RA sources from data"
    detection: "gcp_expression == 'NULL' AND ra_expression references a real column"
    resolution: "Replace NULL with the actual source column reference"
    confidence: 0.95
    first_seen: "WorkOrder.RsTimeRangeId"
    
  - id: PAT-005
    name: "Column stores lookup value instead of raw ID"
    signature: "GCP stores a resolved name/description; RA stores the raw numeric ID"
    detection: "gcp_expression references a joined lookup column; ra_expression references the raw source column"
    resolution: "Change GCP to store raw ID, or add separate column for resolved name"
    confidence: 0.90
    first_seen: "WorkOrder.ActualCompletedBy"
    
  - id: PAT-006
    name: "Incremental window miss (stale data)"
    signature: "Values differ but code logic is identical; lz source matches one side"
    detection: "code_diff is empty AND lz_value == gcp_value != ra_value (or vice versa)"
    resolution: "Full reload resolves; not a code bug"
    confidence: 0.95
    first_seen: "Invoice.RsLogTime"
    
  - id: PAT-007
    name: "Dedup strategy difference (ROW_NUMBER vs MAX)"
    signature: "GCP uses ROW_NUMBER OVER (ORDER BY x DESC); RA uses MAX(x) subquery"
    detection: "Different dedup functions for the same join"
    resolution: "Align dedup strategy; check for ties"
    confidence: 0.85
    first_seen: "WorkOrder.WOWorkGroup"
```

### 7.3 Investigation state (persisted per investigation)

Each investigation is a persistent object (not a chat window):

```yaml
investigation:
  id: "INV-2026-0308-WorkOrder"
  table: "cl_unified_pms.WorkOrder"
  status: "in_progress"  # or completed, blocked, paused
  created: "2026-03-08T14:00:00Z"
  
  columns:
    - name: "ActualCompletedBy"
      status: "root_cause_confirmed"
      diff_type: "column_sourcing"
      pattern_matched: "PAT-005"
      confidence: 0.95
      fix_proposed: true
      fix_tested: true
      fix_test_result: "pass"
      
    - name: "Status"
      status: "diagnostic_queries_running"
      diff_type: "data_level"
      pattern_matched: null
      confidence: 0.60
      queries_executed: [...]
      results: [...]
  
  gcp_lineage: {parsed AST}
  ra_lineage: {parsed AST}
  queries_log: [...]
  human_decisions: [...]
```

### 7.4 Templates (for output generation)

Agent stores Jinja2-style templates for:
1. **Defect report** — modeled after `Invoice_Parity_Defect_Report.md` (the exact structure of that document should be the template)
2. **Developer message** — ticket-ready fix description
3. **Lineage document** — source-to-target column mapping
4. **Audit log entry** — structured JSON for each agent action

### 7.5 Format-ignore rules

```yaml
format_ignores:
  - column_pattern: "*Dt"
    condition: "values differ only in datetime string formatting (ISO vs display)"
  - column_pattern: "ServiceComments"
    condition: "values differ only in whitespace or encoding"
  - column_pattern: "*OnHold*Dt"
    condition: "values differ only in datetime precision (seconds vs milliseconds)"
```

### 7.6 Escalation contacts

```yaml
escalation:
  level_1:
    - role: "GCP Data Engineer"
      channel: "teams://gcp-dev-channel"
    - role: "RA/BI Data Engineer"
      channel: "teams://bi-dev-channel"
    - role: "Data Analyst"
      name: "Raja Gandewar"
  level_2:
    - role: "Team Lead"
  level_3:
    - role: "Data Platform Manager"
```

---

## 8. Technologies and Dependencies — What to Build With

### 8.1 Agent core

| Component | Technology | Why |
|-----------|-----------|-----|
| **Agent framework** | Python + LangChain/LangGraph or custom orchestrator | Manages the multi-step workflow with branching and human gates |
| **LLM** | GPT-4 / Claude / Gemini (swappable) | Code analysis, natural-language diff interpretation, report writing. NOT for query execution — that's deterministic. |
| **SQL parser** | `sqlglot` (Python) | Parses both BigQuery and SQL Server SQL into ASTs for comparison. Handles dialect translation. |

### 8.2 Connectors

| Connector | Library | Purpose |
|-----------|---------|---------|
| BigQuery | `google-cloud-bigquery` | Execute queries, read schemas, deploy procedures |
| SQL Server | `pyodbc` + appropriate ODBC driver | Execute queries, run `sp_helptext`, read schemas |
| Azure DevOps Git | `azure-devops` Python SDK or REST API | Read SP files, create branches, create PRs |
| Azure DevOps Boards | Same SDK / REST API | Create/update work items |
| Slack / Teams | `slack_sdk` / `pymsteams` or webhook | Send human gate notifications |

### 8.3 Persistence

| Store | Technology | What's stored |
|-------|-----------|--------------|
| Investigation state | PostgreSQL or Firestore | Current investigation objects (Section 7.3) |
| Pattern library | YAML files in Git repo (version-controlled) | Known patterns (Section 7.2) |
| Nomenclature mapping | YAML files in Git repo | Column/table/function mappings (Section 7.1) |
| Audit log | BigQuery table | Every query, decision, and action |
| Report archive | Cloud Storage (GCS) | Generated defect reports and lineage docs |

### 8.4 Orchestration

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Scheduler | Cloud Scheduler / Airflow | Trigger agent on parity test completion or on schedule |
| Workflow engine | LangGraph / Prefect / custom state machine | Manage the multi-phase workflow with branching, retries, and human gates |
| Queue | Cloud Tasks / Pub/Sub | Queue query executions, handle async human responses |

### 8.5 Architectural diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRIGGER LAYER                                │
│  Parity test webhook ─── or ─── Cloud Scheduler (cron)             │
└──────────────────────────────┬──────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AGENT WORKFLOW ENGINE                            │
│                                                                     │
│  Phase A          Phase B          Phase C         Phase D          │
│  Intake    ──►    Source     ──►   Compare   ──►  Query+Interpret   │
│                   Lineage          Code             (loop)          │
│                                                       │             │
│                                                       ▼             │
│                   Phase G          Phase F         Phase E          │
│                   Push+Deploy ◄── Test in QA  ◄── Propose Fix      │
│                   (GATED)         (auto)          (auto/gated)      │
│                                                                     │
│  ┌─────────────────────────────────────────────────┐               │
│  │              LLM MODULE (when needed)           │               │
│  │  - Ambiguous code interpretation                │               │
│  │  - Natural-language report generation           │               │
│  │  - Complex root cause reasoning                 │               │
│  │  NOT USED FOR: query generation (deterministic) │               │
│  │                query execution (API calls)      │               │
│  │                pattern matching (rules engine)  │               │
│  └─────────────────────────────────────────────────┘               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│  BigQuery Client │ │  SQL Server      │ │  Azure DevOps API    │
│  - QA queries    │ │  - RA queries    │ │  - Read SP files     │
│  - PROD queries  │ │  - sp_helptext   │ │  - Create PRs        │
│  - lz queries    │ │  - Schema reads  │ │  - Update tickets    │
│  - Deploy procs  │ │                  │ │                      │
└──────────────────┘ └──────────────────┘ └──────────────────────┘
           │                   │                   │
           └───────────────────┼───────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PERSISTENCE LAYER                              │
│                                                                     │
│  ┌─────────────┐ ┌────────────┐ ┌──────────┐ ┌─────────────────┐  │
│  │Investigation│ │  Pattern   │ │ Audit    │ │  Nomenclature   │  │
│  │   State DB  │ │  Library   │ │ Log (BQ) │ │  Mapping (YAML) │  │
│  └─────────────┘ └────────────┘ └──────────┘ └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 9. Lineage and Documentation Generation

### How the agent produces lineage automatically

The agent generates a lineage document by:

1. **Parsing SP code** into an AST using `sqlglot`:
   - Extract `CREATE TEMP TABLE ... AS SELECT` → map source columns to temp columns
   - Extract `UPDATE temp SET col = expr FROM joined_table` → map update sources
   - Extract `MERGE target USING source ON keys WHEN MATCHED THEN UPDATE SET ...` → map temp columns to target columns

2. **Building a column-level DAG:**
   ```
   lz_onesite.OneSiteProperty_dbo_WorkOrder.woactualcompleteby
     → Temp_WorkOrder.ActualCompletedBy (via SELECT expression)
       → cl_unified_pms.WorkOrder.ActualCompletedBy (via MERGE)
   ```

3. **Required access:**
   - GCP: Read repo for SP code + BigQuery `INFORMATION_SCHEMA` for schema
   - RA: `sp_helptext` or read repo for SP code + SQL Server `INFORMATION_SCHEMA`

4. **Output:** Markdown document following the template from the Invoice defect report structure — with source-to-target mapping, join dependencies, and downstream consumer list.

---

## 10. Known Bottlenecks and How to Solve Them

| # | Bottleneck | Impact | Solution |
|---|-----------|--------|----------|
| 1 | **RA lineage sourcing via `sp_helptext`** | Slowest manual step (3-6 hours). Even automated, requires SQL Server connectivity and multiple round-trips. | **Priority:** Get read access to BI code repository. Makes RA sourcing identical to GCP (file read via API). **Fallback:** Agent batch-extracts all `Facilities.*` procs on first run, caches them, re-extracts only when version metadata changes. |
| 2 | **LLM context limits** | Full SP code can be 2000+ lines per side. LLM can't hold both in context simultaneously. | Agent uses `sqlglot` for mechanical parsing/comparison. LLM only called for ambiguous interpretation. Per-column lineage extraction reduces context to ~50 lines per call. |
| 3 | **SQL Server connectivity over VPN** | Latency (5-30s per query), potential timeouts. | Agent batches RA queries into single sessions. Uses connection pooling. Pre-indexes WHERE clause columns. |
| 4 | **Cross-team fix coordination** | Some fixes require RA/BI team action, not just GCP. | Agent generates a complete investigation report with evidence. The human analyst forwards it. Agent tracks via ticket status. |
| 5 | **Parity test report format variability** | Different test frameworks may output different formats. | Agent includes a pluggable parser module. Standardize on a JSON/CSV schema for parity output. |
| 6 | **False positives from incremental timing** | PROD incremental may lag behind QA full reload, causing spurious diffs. | Agent checks ETL load logs to determine if PROD has run a full reload recently. If not, agent flags timing-related diffs separately and recommends a reload before investigating further. |

---

## 11. Acceptance Criteria — How to Validate the Agent Works

| # | Criterion | How to test | Target |
|---|-----------|-------------|--------|
| 1 | **Reproduces WorkOrder root causes** | Feed agent the WorkOrder parity report from the historical investigation. Check if it identifies the same 7 root causes for columns 5-11. | >= 6 of 7 match (86%) |
| 2 | **Reproduces Invoice root causes** | Feed agent the Invoice parity report. Check if it identifies cross-PMC contamination as root cause for all 3 name columns. | 3 of 3 match (100%) |
| 3 | **Correctly auto-skips format diffs** | Feed agent columns 1-4 from WorkOrder (format-only). Agent should classify all as format and skip. | 4 of 4 auto-skipped |
| 4 | **Generates correct diagnostic queries** | Compare agent-generated queries to the queries manually written during investigation. Queries should return equivalent results. | Queries execute without error; results match within 1% |
| 5 | **Flags ambiguous cases** | Agent encounters `Status` column (data-level, low confidence). Should flag for human review, not auto-resolve. | Agent pauses at GATE 1 |
| 6 | **Logs every action** | Review audit trail after a full investigation run. Every query, result, decision, and output should be logged with timestamps. | 100% action coverage in audit log |
| 7 | **Generates defect report** | Compare agent-generated report to `Invoice_Parity_Defect_Report.md`. Structure, depth, and evidence quality should be comparable. | Peer review: "would approve for production" |
| 8 | **End-to-end time** | Run agent on a table with ~10 mismatched columns. Measure wall-clock time from intake to defect report (excluding human gate wait time). | < 4 hours |
| 9 | **QA fix test works** | Agent deploys fixed procedure to QA scratch, runs reload, confirms parity diffs drop to 0. | Diffs = 0 for fixed columns, no regressions |

### Validation plan

1. **Phase 1 — Replay:** Feed agent the exact WorkOrder and Invoice cases with historical inputs. Verify outputs match human investigation.
2. **Phase 2 — Parallel:** Agent runs alongside human on the next new table. Compare results and timing.
3. **Phase 3 — Supervised:** Agent runs independently; human reviews all outputs before action.
4. **Phase 4 — Autonomous with gates:** Agent runs independently, pausing only at defined human gates.

---

## 12. Deliverables Checklist

This document IS the specification. The complete deliverable package is:

| # | Deliverable | File | Status |
|---|-------------|------|--------|
| 1 | **Agent build specification** (this document) | `AGENT_BUILD_SPEC.md` | This file |
| 2 | **RA-GCP nomenclature mapping** (initial version for agent memory) | `RA_GCP_Nomenclature_Mapping.md` | Created |
| 3 | **Historical case reference** (WorkOrder + Invoice root causes) | `AI_Agent_Migration_Brief.md` + `AI_Agent_Migration_Brief_Part2.md` | Created |
| 4 | **Defect report template** (use Invoice report as the template) | `Invoice_Parity_Defect_Report.md` | Existing — this IS the template |
| 5 | **Permission and access matrix** | Section 6 of this document | Included above |
| 6 | **Technology and dependency list** | Section 8 of this document | Included above |
| 7 | **Human-in-the-loop decision map** | Section 5 of this document | Included above |
| 8 | **Memory standardization** (patterns, mapping, templates, rules) | Section 7 of this document | Included above |
| 9 | **Acceptance criteria** | Section 11 of this document | Included above |

---

*End of Agent Build Specification*
