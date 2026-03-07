# AI Agent Migration Brief: RA-GCP Data Parity Reconciliation Agent

**Version:** 1.0  
**Date:** 2026-03-08  
**Author:** Raja Gandewar  
**Status:** Draft Specification

---

## Table of Contents

1. [Purpose](#1-purpose)
2. [Executive Summary](#2-executive-summary)
3. [Exported Context and Conversation Decisions](#3-exported-context-and-conversation-decisions)
4. [Problem Definition and Mismatch Examples](#4-problem-definition-and-mismatch-examples)
5. [Current Manual Process (What the Agent Replaces)](#5-current-manual-process-what-the-agent-replaces)
6. [Agent Inputs and Outputs](#6-agent-inputs-and-outputs)
7. [Use Cases and Workflows](#7-use-cases-and-workflows)
8. [Human-in-the-Loop Decision Map](#8-human-in-the-loop-decision-map)
9. [Permissions and Access Matrix](#9-permissions-and-access-matrix)
10. [Technologies and Dependencies](#10-technologies-and-dependencies)
11. [Lineage and Documentation Generation](#11-lineage-and-documentation-generation)
12. [Memory and Standardization](#12-memory-and-standardization)
13. [RA-GCP Nomenclature Mapping](#13-ra-gcp-nomenclature-mapping)
14. [Known Edge Cases and Failure Modes](#14-known-edge-cases-and-failure-modes)
15. [Bottlenecks and Mitigation Strategies](#15-bottlenecks-and-mitigation-strategies)
16. [Acceptance Criteria](#16-acceptance-criteria)
17. [Appendix A: Templates](#appendix-a-templates)
18. [Appendix B: Historical Case Library](#appendix-b-historical-case-library)

---

## 1. Purpose

Create an AI agent to **detect, investigate, and resolve data mismatches between RA (SQL Server/BI) and GCP (BigQuery)**, automating the current manual workflow of lineage sourcing, code comparison, diagnostic querying, root cause analysis, and fix proposal, while preserving human oversight where required.

The agent replaces the human analyst in:
- Sourcing and compiling lineage documents, stored procedure code, schemas, and related metadata
- Structuring the investigation in the correct order of operations
- Writing and executing diagnostic SQL queries on both platforms
- Interpreting query results and classifying mismatch root causes
- Proposing fixes and generating investigation reports, lineage documentation, and audit trails

---

## 2. Executive Summary

### What exists today
A manual, analyst-driven workflow where a parity test framework flags mismatched columns, then an analyst (currently Raja Gandewar) manually sources RA lineage via `sp_helptext`, sources GCP lineage from the BigQuery code repository, compares them side-by-side, writes diagnostic queries, interprets results, and produces defect reports. This takes **3-10 days per table**.

### What the agent will do
Automate the full investigation end-to-end with human approval gates at defined decision points. Target: **< 4 hours per table**.

### Scale
- ~20+ tables in `cl_unified_pms`, 40-65 columns each
- Typical: 5-15 mismatched columns per investigation cycle

---

## 3. Exported Context and Conversation Decisions

### 3.1 WorkOrder Investigation

**Tables:** GCP `cl_unified_pms.WorkOrder` / RA `dbo.DimWorkOrder`  
**GCP proc:** `cl_unified_pms.sp_WorkOrder_upsert`  
**RA proc:** `Facilities.asp_MergeWorkOrderIntoStaging`

#### Parity test: 11 mismatched columns

| # | Column | Classification | Action |
|---|--------|---------------|--------|
| 1-4 | respondeddt, servicecomments, woohonholdstartdt, woohonholdenddt | Format difference | Ignore |
| 5 | actualcompletedby | Column sourcing error | Fix GCP |
| 6 | actualcompletedbyemployee | Join filter mismatch | Fix GCP |
| 7 | createdbyemployee | Join filter mismatch | Fix GCP |
| 8 | mractualworkminutes | Calculation logic | Fix GCP |
| 9 | rstimerangeid | Hardcoded NULL | Fix GCP |
| 10 | status | Data-level issue | Investigate RA staging |
| 11 | woworkgroup | Sourcing gap + RA logic | Fix both |

#### Root causes confirmed

- **actualcompletedby:** GCP stores `E.EmployeeNm` (name) instead of raw numeric `wo.woactualcompleteby`
- **employee columns:** GCP adds `UserDisableInd = 0` filter not present in RA
- **mractualworkminutes:** `DATE_DIFF` argument order inversion + `ActualWorkOutDt` vs `ActualMoveOutDt` mismatch
- **rstimerangeid:** Was hardcoded `NULL`; fixed to `wo.TRID AS RsTimeRangeId`
- **status:** Data-level divergence in CodeLookup between GCP and RA
- **woworkgroup:** GCP `ROW_NUMBER()` vs RA `MAX(createdDate)` with NULL WorkGroup ties

#### Key decisions
1. Format-only mismatches auto-excluded
2. Investigation follows dependency order (ID before name columns)
3. Root causes confirmed with diagnostic queries before proposing fixes
4. Zero employee IDs require explicit human decision (store "0" or NULL)

### 3.2 Invoice Investigation

**Root cause:** Cross-PMC contamination — `user_id` reused across PMCs, join missing `cdspmcid` scope.  
**Affected:** `ApproverNm`, `RsCreatedByNm`, `RsModifiedByNm` (577-1834 out of 1848 rows wrong).  
**Fix:** Add `cdspmcid` to user profile join (v1.3 committed).  
**Pattern:** Cross-PMC contamination is a recurring bug class.

---

## 4. Problem Definition and Mismatch Examples

### 4.1 Mismatch taxonomy

| Type | Description | Example |
|------|-------------|---------|
| **Format** | Same data, different string representation | DateTime formatting |
| **Join filter** | Extra/missing filter in lookup join | `UserDisableInd = 0` |
| **Cross-scope** | Join missing scoping key | Employee join without PMCID |
| **Column sourcing** | Wrong source column or hardcoded NULL | `E.EmployeeNm` instead of raw ID |
| **Calculation** | Different formula/arg order | `DATE_DIFF` arg reversal |
| **Data-level** | Same logic but different lookup data | CodeLookup divergence |
| **Sourcing gap** | One side doesn't source the column | WOWorkGroup from different table |
| **ETL timing** | Incremental window miss | Stale `RsLogTime` |
| **Deduplication** | Different dedup strategy | `ROW_NUMBER` vs `MAX` with ties |

### 4.2 Representative examples

**Join filter mismatch:**
```sql
-- GCP: extra UserDisableInd filter
LEFT JOIN cl_unified_pms.Employee E
  ON E.RsEmployeeNb = wo.woactualcompleteby
  AND E.DeletedInd = FALSE
  AND E.UserDisableInd = 0          -- NOT in RA

-- RA: only delete filter
LEFT JOIN #Employee EAC
  ON EAC.osl_EmployeeNumber = CAST(WO.actualCompletedBy AS VARCHAR(10))
  AND EAC.IsDeleted <> 'Y'
```

**Cross-PMC contamination:**
```sql
-- v1.1 BUG: no cdspmcid in join
LEFT JOIN tmp_user_profile E2 ON I.invapprover = E2.user_id

-- v1.3 FIX: scoped to PMC
LEFT JOIN tmp_user_profile E2 ON I.invapprover = E2.user_id AND I.cdspmcid = E2.cdspmcid
```

---

## 5. Current Manual Process (What the Agent Replaces)

```
PHASE 1: INTAKE (30 min)
├── Receive parity test report → identify mismatched columns
├── Classify format-only mismatches → exclude
└── Identify actionable columns

PHASE 2: LINEAGE SOURCING (4-8 hours) ← BIGGEST BOTTLENECK
├── GCP: Read sp_*_upsert.sql from repo, trace dependencies
├── RA: Run sp_helptext on SQL Server, trace table chain manually
└── Compile side-by-side comparison

PHASE 3: ROOT CAUSE ANALYSIS (2-4 hours)
├── Compare GCP vs RA code per column
├── Write diagnostic queries for both sides
├── Execute, interpret, confirm root cause
└── Classify into taxonomy

PHASE 4: FIX PROPOSAL (1-2 hours)
├── Draft code changes (before/after SQL)
├── Write verification queries
├── Draft developer messages and defect report
└── Submit for review

PHASE 5: DEPLOYMENT (post-approval)
├── Deploy procedure change → full reload → re-run parity test
```

### Manual prompts replaced by agent

The analyst currently prompts an LLM with lineage code, asks for column-by-column analysis, feeds back query results, and iterates. **The agent does all of this autonomously**, executing queries itself.

### Existing heuristics the agent must encode

| Rule | Description |
|------|-------------|
| PMC scoping check | Every employee/user join MUST include PMCID |
| Deleted flag alignment | GCP `DeletedInd = FALSE` ≡ RA `IsDeleted <> 'Y'` |
| Disable vs Delete | Separate flags — RA only filters on delete |
| DATE_DIFF arg order | BQ: `DATE_DIFF(end, start, part)` vs SS: `DATEDIFF(part, start, end)` |
| Hardcoded NULLs | Check for `CAST(NULL AS type)` that should map to a real column |
| QUALIFY vs CTE | BQ inline `QUALIFY` = SS CTE + WHERE; verify partition/order match |
| CDSExtractType filter | GCP `<> 'Delete'` ≡ RA `<> 'D'` |
| Incremental artifacts | Always check if full reload resolves before blaming code |

---

## 6. Agent Inputs and Outputs

### Inputs

| Input | Source | Purpose |
|-------|--------|---------|
| Parity test report | Test framework (HTML/CSV) | Trigger investigation |
| GCP stored procedure code | BigQuery code repo (Azure DevOps) | GCP lineage |
| RA stored procedure code | SQL Server `sp_helptext` or BI repo | RA lineage |
| GCP/RA table schemas | `INFORMATION_SCHEMA` | Schema comparison |
| GCP QA dataset | `ai-data-platform-qa-5201.cl_unified_pms.*` | Diagnostic queries |
| GCP PROD dataset | `ai-data-platform-prod.cl_unified_pms.*` | Verification |
| RA source tables | `dbo.Dim*`, `Facilities.*` | Diagnostic queries |
| Landing zone tables | `lz_onesite.*` | Source-of-truth verification |
| ETL load logs | `cl_unified_pms.etl_load_log` | ETL timing analysis |
| Repository diffs | Azure DevOps API | Change impact analysis |
| Historical cases | Agent memory | Pattern matching |

### Outputs

| Output | Format | Purpose |
|--------|--------|---------|
| Mismatch classification | JSON + Markdown | Categorize each mismatch |
| Root cause analysis | Markdown with SQL evidence | Explain each mismatch |
| Diagnostic queries | `.sql` files | Confirm root cause |
| Proposed code fixes | Before/after diffs | What to change |
| Verification queries | `.sql` files | Confirm fix post-deploy |
| Developer messages | Formatted text | Communicate findings |
| Defect report | Markdown (template-based) | Complete investigation record |
| Lineage document | Markdown | Data lineage artifact |
| Audit trail | Structured JSON | Compliance logging |
| Tickets/alerts | Jira/ADO work items | Track fixes |

---

## 7. Use Cases and Workflows

### UC-1: Detect Schema or Data-Type Mismatches

**Trigger:** New table onboarded or schema change detected.  
**Logic:** Compare `INFORMATION_SCHEMA.COLUMNS` between GCP and RA using nomenclature mapping. Flag type incompatibilities, missing columns, nullability differences.  
**Success:** All column pairs mapped; type mismatches flagged with severity.

### UC-2: Identify Missing or Duplicate Records

**Trigger:** Row count difference in parity test.  
**Logic:** Compare counts by key columns; run anti-joins to find orphan keys; trace back to source lz tables; check CDSExtractType filters, QUALIFY/dedup, incremental windows.  
**Success:** All row count differences explained with root cause.

### UC-3: Reconcile Conflicting Field Values

**Trigger:** Column-level value differences for matched keys.  
**Logic (per column):**
1. **Triage** — check format-ignore list, check known patterns in memory
2. **Lineage comparison** — extract GCP and RA code paths for the column
3. **Diff analysis** — compare source columns, joins, filters, expressions
4. **Diagnostic queries** — write and execute on GCP QA, RA, and lz source
5. **Root cause confirmation** — compare results across all three
6. **Fix proposal** — draft minimal code change, verification query, risk assessment

**Success:** Root cause confirmed with evidence for every column; fix is minimal and targeted.

### UC-4: Generate Lineage Documentation

**Trigger:** New table investigation or code change proposed.  
**Logic:** Parse stored procedures to build column-level DAG from source → temp → target. Identify downstream consumers.  
**Success:** Every column has documented source path; downstream impacts identified.

---

## 8. Human-in-the-Loop Decision Map

### Where approval is required

| Decision Point | Evidence Required | Risk Level |
|---------------|-------------------|------------|
| Business rule ambiguity | Side-by-side comparison | LOW |
| Code change to PROD | Before/after diff + verification results | MEDIUM |
| Data patch on production | Row count, sample, rollback plan | HIGH |
| Full reload trigger | Justification, runtime estimate | MEDIUM |
| Confidence < 80% | All evidence + alternative hypotheses | MEDIUM |
| Irreversible state change | Full impact assessment | HIGH |
| Cross-team escalation | Complete investigation report | MEDIUM |

### Human prompt format

```markdown
## Human Decision Required
**Table:** cl_unified_pms.WorkOrder | **Column:** ActualCompletedBy
**Type:** Column sourcing error

### Context
GCP stores employee name; RA stores numeric ID. Schema expects INT64.

### Question
When source `woactualcompleteby = 0` (no employee): Store "0" or NULL?

### Evidence
- RA stores: 0 | GCP currently: NULL | Source lz: 0

### Recommendation
Option A — store "0" for parity with RA.

### Impact
~2,400 rows where no employee was assigned.
```

### Approval workflows
- **LOW RISK:** Agent proposes → Single reviewer → QA verify → Deploy
- **MEDIUM RISK:** Agent proposes → Developer + Analyst review → Team lead approve → Deploy
- **HIGH RISK:** Agent proposes → Full review → Manager approve → Deploy with rollback

---

## 9. Permissions and Access Matrix

| Resource | Permission | Purpose |
|----------|-----------|---------|
| `ai-data-platform-qa-5201.cl_unified_pms.*` | READ | QA diagnostic queries |
| `ai-data-platform-prod.cl_unified_pms.*` | READ | PROD verification |
| `ai-data-platform-prod.lz_onesite.*` | READ | Source-of-truth checks |
| `ai-data-platform-prod.INFORMATION_SCHEMA` | READ | Schema comparison |
| RA SQL Server (BI database) | READ + EXECUTE `sp_helptext` | RA queries + code extraction |
| Azure DevOps Git repository | READ | GCP stored procedure source |
| BI code repository (if available) | READ | RA stored procedure source |
| Jira / Azure DevOps Work Items | CREATE, UPDATE | Tickets and tracking |
| `ai-data-platform-qa-5201.scratch.*` | WRITE | QA testing (no approval needed) |
| PROD procedures (DDL) | EXECUTE | Deploy approved changes (requires PR approval) |
| PROD data (DML) | WRITE | Approved full reloads (requires team lead approval) |

**Network:** BigQuery via VPC Private Google Access; SQL Server via VPN/Private Endpoint. All queries audit-logged.

---

## 10. Technologies and Dependencies

| Component | Technology | Purpose |
|-----------|-----------|---------|
| LLM / Decision Model | GPT-4 / Claude / Gemini | Code analysis, triage, report generation |
| BigQuery connector | `google-cloud-bigquery` Python | Execute GCP queries |
| SQL Server connector | `pyodbc` / `pymssql` | Execute RA queries, `sp_helptext` |
| Repository API | Azure DevOps REST API | Fetch SP source files |
| Rules engine | Python + YAML config | Business logic, format-ignore, patterns |
| Orchestration | Airflow / Cloud Composer | Schedule runs, chain steps |
| Audit trail | BigQuery audit dataset | Log queries, decisions, actions |
| Tickets | Jira / ADO REST API | Work item management |
| Notifications | Slack / Teams webhook | Human alerts |
| Doc generation | Jinja2 + Markdown | Reports from templates |

### Architecture (simplified)

```
Orchestration (Airflow)
  → Agent Core (Python)
    → LLM Module (code analysis, summaries)
    → Rules Engine (YAML policies, known patterns)
    → Investigation Engine (lineage parser, query generator, result interpreter)
  → Connectors (BigQuery, SQL Server, Git, Jira)
  → Persistence (Memory Store, Audit Log, Pattern Library, Report Archive)
```

---

## 11. Lineage and Documentation Generation

The agent produces lineage by:
1. **Parsing SP code** — extract CREATE/INSERT/UPDATE/MERGE statements; build column-level DAG
2. **Resolving cross-proc dependencies** — trace GCP `sp_*_upsert` chain; trace RA `Staging → StagingSource → StagingDim → Dim` chain
3. **Access requirements** — GCP repo read; RA `sp_helptext` or repo read; `INFORMATION_SCHEMA` on both
4. **Downstream impact** — identify views, procedures, dashboards consuming each table

---

## 12. Memory and Standardization

### Common mismatch patterns

| ID | Pattern | Resolution | Confidence |
|----|---------|------------|------------|
| PAT-001 | Employee join with `UserDisableInd=0` in GCP only | Remove filter | 95% |
| PAT-002 | Cross-PMC contamination (join missing `cdspmcid`) | Add scoping key | 99% |
| PAT-003 | `DATE_DIFF` argument order inversion | Swap arguments | 90% |
| PAT-004 | Hardcoded NULL where source column exists | Use actual column | 95% |
| PAT-005 | DateTime format as STRING with different formatting | Align CAST or ignore | 85% |
| PAT-006 | `ROW_NUMBER()` vs `MAX()` with ties | Align dedup | 85% |
| PAT-007 | Incremental window miss → stale data | Full reload | 95% |
| PAT-008 | CodeLookup data divergence | Sync reference data | 75% |
| PAT-009 | RA encryption columns | Use DECRYPTBYKEY in queries | 90% |

### Approved thresholds

| Rule | Threshold | Action |
|------|-----------|--------|
| Format-only mismatch | N/A | Auto-skip |
| Row count diff < 0.1% | 0.1% | Warning |
| Row count diff >= 0.1% | 0.1% | Critical |
| Column value diff < 0.5% | 0.5% | Low priority |
| Column value diff >= 5% | 5% | High priority |
| Financial column diffs | 0 tolerance | Critical |

### Escalation contacts
- **Level 1:** GCP Dev Team / BI Dev Team / Data Analyst (Raja Gandewar)
- **Level 2:** Team Lead
- **Level 3:** Data Platform Manager

---

*Continued in Part 2: AI_Agent_Migration_Brief_Part2.md*
