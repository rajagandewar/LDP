# AI Agent Migration Brief — Part 2

*Continuation of AI_Agent_Migration_Brief.md*

---

## 13. RA-GCP Nomenclature Mapping

### 13.1 Database and table naming

| Concept | GCP (BigQuery) | RA (SQL Server) |
|---------|---------------|-----------------|
| Dataset/Schema | `cl_unified_pms` | `dbo` / `Facilities` |
| WorkOrder table | `cl_unified_pms.WorkOrder` | `dbo.DimWorkOrder` |
| Invoice table | `cl_unified_pms.Invoice` | `dbo.DimInvoice` |
| Employee table | `cl_unified_pms.Employee` | `dbo.DimEmployee` |
| CodeLookup table | `cl_unified_pms.CodeLookup` | `dbo.DimCodeLookup` |
| Property table | `cl_unified_pms.Property` | `dbo.DimProperty` |
| Unit table | `cl_unified_pms.Unit` | `dbo.DimUnit` |
| Building table | `cl_unified_pms.Building` | `dbo.DimBuilding` |
| Lease table | `cl_unified_pms.Lease` | `dbo.FactLease` + `dbo.DimLeaseAttributes` |
| ServiceRequest | `cl_unified_pms.ServiceRequest` | `dbo.DimServiceRequest` |
| Calendar | `cl_unified_pms.StandardCalendar` | `dbo.DimStandardCalendar` |
| Landing zone | `lz_onesite.OneSiteProperty_dbo_*` | `Facilities.Staging*` / `Facilities.StagingSource*` |
| SP naming | `cl_unified_pms.sp_<Table>_upsert` | `Facilities.asp_Merge<Table>IntoStaging` |
| Source SP | N/A | `Facilities.asp_MergeSource<Table>IntoSource` |

### 13.2 Column naming conventions

| GCP Pattern | RA Pattern | Meaning |
|-------------|------------|---------|
| `Rs<Name>` | `osl_<Name>` | Source system identifier |
| `RsPMCID` | `osl_PMCID` / `osl_CDSPMCID` | PMC ID |
| `RsPropertyID` | `osl_PropertyID` | Property ID |
| `RsWorkOrderId` | `osl_WOID` | Work Order ID |
| `RsServiceRequestId` | `osl_SRID` | Service Request ID |
| `RsTimeRangeId` | `osl_TRID` | Time Range ID |
| `RsEmployeeNb` | `osl_EmployeeNumber` | Employee number |
| `RsUnitId` | `osl_UnitID` | Unit ID |
| `DeletedInd` (BOOL) | `IsDeleted` (CHAR 'Y'/'N') | Soft delete flag |
| `*Ind` (BOOL) | `*Bit` (BIT 0/1) | Boolean indicators |
| `*Dt` / `*Dtm` | `*Date` | Datetime columns |
| `*Cnt` | `*Count` | Count/numeric columns |
| `*Nm` | `*Name` | Name/string columns |
| `*Dsc` | `*Description` | Description columns |
| `*Cd` | `*Code` | Code/status columns |
| `ETLModifiedDtm` | `RecordModifiedDate` | ETL timestamp |
| `MakeReadyInd` | `MakeReadyFlag` (0/1) | Make-ready indicator |

### 13.3 Filter expression mapping

| GCP Expression | RA Expression | Semantic |
|---------------|---------------|----------|
| `DeletedInd = FALSE` | `IsDeleted <> 'Y'` | Not deleted |
| `CDsExtractType <> 'Delete'` | `CDSExtractType <> 'D'` | Not a delete extract |
| `UserDisableInd = 0` | *(no equivalent)* | GCP-only filter (often a bug) |
| `COALESCE(E.RsPMCID, wo.cdspmcid)` | `ISNULL(EAC.osl_CDSPMCID, WO.CDSPMCID)` | PMC fallback |
| `QUALIFY ROW_NUMBER() OVER(...)` | CTE + `WHERE rn = 1` | Deduplication |
| `DATE_DIFF(end, start, DAY)` | `DATEDIFF(DAY, start, end)` | Date diff (note arg order!) |
| `TIMESTAMP_DIFF(end, start, MINUTE)` | `DATEDIFF_BIG(MINUTE, start, end)` | Timestamp diff |
| `INITCAP(x)` | `[dbo].[InitCap](x)` | Title case |
| `IFNULL(x, y)` | `ISNULL(x, y)` | Null replacement |
| `GENERATE_UUID()` | `NEWID()` | UUID generation |

### 13.4 Stored procedure structure mapping

| Step | GCP Pattern | RA Pattern |
|------|-------------|------------|
| Entry guard | `tf_CheckLastRunStatus` | `AggregateControl` table check |
| Date boundary | `sp_GetDateBoundary` | `FactStartDate`/`LastLoadDate` from `udfGetPropertyList` |
| Logging | `sp_LogRunStatus` | `Admin.asp_ETLProcessLog` |
| Main temp table | `CREATE TEMP TABLE Temp_<Table>` | `INSERT INTO Facilities.StagingDim<Table>` |
| Post-processing | `UPDATE Temp_<Table>` | `UPDATE dbo.Dim<Table>` (Steps 10-14) |
| Final write | `MERGE cl_unified_pms.<Table>` | `MERGE dbo.Dim<Table>` |
| Cleanup | Temp tables auto-drop | Explicit `DROP TABLE`, `DROP INDEX` |
| Error handling | `EXCEPTION WHEN ERROR THEN` | `BEGIN TRY / BEGIN CATCH` |

### 13.5 WorkOrder-specific column mapping

| GCP Column | RA Column | Source (lz/staging) | Notes |
|-----------|-----------|---------------------|-------|
| `RsWorkOrderId` | `osl_WOID` | `wo.WOID` | Primary key component |
| `RsPropertyID` | `osl_PropertyID` | `wo.CDSPropertyID` | Primary key component |
| `RsPMCID` | `osl_PMCID` | `wo.CDSPMCID` | Primary key component |
| `RsTimeRangeId` | `osl_TRID` | `wo.TRID` | Was hardcoded NULL in GCP |
| `ActualCompletedBy` | `ActualCompletedBy` | `wo.actualCompletedBy` | GCP stored name; RA stores ID |
| `ActualCompletedByEmployee` | `ActualCompletedByEmployee` | Employee join on `actualCompletedBy` | GCP extra `UserDisableInd` filter |
| `CreatedByEmployee` | `CreatedByEmployee` | Employee join on `createdBy` | Same UserDisableInd issue |
| `Status` | `Status` | CodeLookup join on `StatusCode` | Data-level divergence |
| `WOWorkGroup` | `WOWorkGroup` | ServiceRequestHistory + WorkGroup | Different dedup strategy |
| `MRActualWorkMinutes` | `MRActualWorkMinutes` | Calculated from dates | DATE_DIFF arg order issue |
| `WOActualWorkMinutes` | `WOActualWorkMinutes` | Calculated from dates | Similar calculation logic |
| `MakeReadyInd` | `MakeReadyFlag` | `CASE WHEN MRRID IS NOT NULL` | Bool vs Int |
| `ExcludeWeekEndDaysCnt` | `ExcludeWeekEndDaysCount` | Calculated | Suffix difference |
| `OnHoldDaysCnt` | `OnHoldDaysCount` | Calculated | Suffix difference |
| `HolidayCnt` | `HolidayCount` | Calculated | Suffix difference |

---

## 14. Known Edge Cases and Failure Modes

### 14.1 Edge cases

| # | Edge Case | Impact | Handling |
|---|-----------|--------|----------|
| 1 | Employee ID = 0 in source | No employee assigned; GCP join returns NULL, RA stores 0 | Human decision: store "0" or NULL |
| 2 | Same employee number across PMCs | Different people with same ID | Always verify PMCID scoping |
| 3 | CodeLookup deduplication divergence | RA marks dupes as `IsDeleted='Y'` separately | Compare lookup contents |
| 4 | `MAX(createdDate)` ties with NULL WorkGroup | RA picks wrong winner | Validate GCP `ROW_NUMBER()` determinism |
| 5 | lz source re-extraction | Rows replaced with newer `cdssourcelogtime`; incremental may miss | Full reload resolves |
| 6 | RA PII encryption | `ENCRYPTBYKEY/DECRYPTBYKEY` on employee names | Use `DECRYPTBYKEY` in RA queries |
| 7 | BQ `QUALIFY` not in SQL Server | Can't copy-paste queries | Agent translates to CTE pattern |
| 8 | `PropertySourceCode != 1` | RA filters to OneSite; GCP may include others | Verify property scope |
| 9 | MakeReady vs Service Request paths | Different calculation formulas for MR (flag=1) vs SR (flag=0) | Test both paths |
| 10 | `ActualMoveOutDt` vs `ActualWorkOutDt` | Different dates used in different calculation steps | Verify per-step usage |
| 11 | RA Step 12.2 WOWorkGroup missing PMCID in join | RA join on PropertyID+WOID only; GCP adds PMCID | Cross-PMC potential in RA |
| 12 | RA MERGE matched but no value change | RA still updates `RecordModifiedDate`; GCP may skip | Timestamp comparison unreliable |

### 14.2 Failure modes

| Mode | Symptom | Recovery |
|------|---------|----------|
| SQL Server timeout | RA queries fail | Retry with backoff; alert if persists |
| BigQuery quota exhausted | GCP queries fail | Queue; use slot reservations |
| SP code changed mid-investigation | Stale lineage | Re-fetch and restart affected steps |
| No sample rows in parity report | Can't write targeted queries | Broader query with LIMIT; alert analyst |
| Ambiguous root cause | Multiple code diffs per column | Isolation queries per hypothesis; escalate if still ambiguous |
| RA maintenance window | SQL Server unavailable | Pause RA queries; continue GCP; resume when available |

---

## 15. Bottlenecks and Mitigation Strategies

### 15.1 RA lineage sourcing (critical bottleneck)

**Problem:** RA SP code obtained by manually running `sp_helptext` on SQL Server. 3-6 hours per table due to multiple procedures (3-5 per table, 500-2500 lines each) with no centralized code repository.

**Mitigations (ranked):**
1. **Repository access (best):** If BI team has a code repo, grant agent read access — makes RA identical to GCP sourcing
2. **Automated `sp_helptext` extraction:** Agent connects to SQL Server, runs `sp_helptext` for all procedures in the lineage chain, caches results
3. **Pre-extraction batch job:** Nightly job extracts all `Facilities.*` procedures to a shared file store
4. **RA lineage cache:** After first extraction, agent stores SP code in memory; re-fetches only when version metadata changes

### 15.2 RA database access latency

**Problem:** SQL Server queries over VPN may be slow (5-30s per query).

**Mitigations:**
1. Batch multiple diagnostic queries into a single connection session
2. Use indexed columns in WHERE clauses (PMCID, PropertyID, WOID)
3. Pre-create cross-database linked server views if available

### 15.3 LLM context window limits

**Problem:** Full SP code for both sides can exceed 10,000 lines for complex tables.

**Mitigations:**
1. Agent pre-filters SP code to only the relevant column's lineage path before sending to LLM
2. Use structured extraction (regex/AST parsing) for mechanical comparisons; LLM only for ambiguous cases
3. Maintain a "column lineage index" per procedure that maps column → line ranges

### 15.4 Cross-team coordination

**Problem:** Some fixes require RA/BI team action (not GCP team).

**Mitigations:**
1. Agent drafts complete investigation report with evidence → analyst forwards
2. Standardized escalation template with business impact quantification
3. Track cross-team tickets in shared backlog

### 15.5 Parity test report format variability

**Problem:** Different test runs may produce different report formats.

**Mitigations:**
1. Standardize parity test output to JSON/CSV with fixed schema
2. Agent includes a parser module per known format
3. Fallback: Agent asks human to paste mismatched column list

---

## 16. Acceptance Criteria

### 16.1 Functional accuracy

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Reproduces manual resolutions on historical WorkOrder case | >= 90% accuracy | Re-run agent on 11 columns; compare to human root cause |
| Reproduces manual resolutions on historical Invoice case | >= 90% accuracy | Re-run agent on 3 columns; compare to human root cause |
| Correctly classifies format-only mismatches | 100% | No format mismatches escalated for investigation |
| Correctly identifies PMC scoping issues | >= 95% | Pattern PAT-002 applied when relevant |
| Correctly identifies join filter mismatches | >= 90% | Pattern PAT-001 applied when relevant |

### 16.2 Human-in-the-loop

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Flags ambiguous cases for human review | 100% of cases with confidence < 80% | No auto-resolved cases that should have been flagged |
| Logs every decision with evidence | 100% | Audit trail complete for every action |
| Human prompts include sufficient evidence | Reviewer can decide in < 5 min | Feedback survey |
| No unauthorized write operations | 0 unauthorized writes | Audit log review |

### 16.3 Artifact quality

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Lineage document matches SP code | 100% column coverage | Manual spot-check on 2 tables |
| Defect report matches Invoice template quality | Comparable depth and structure | Side-by-side review |
| Audit trail matches actual actions | 100% | Cross-reference with BQ audit logs |
| Developer messages are actionable | Dev can implement fix without clarification | Developer feedback |

### 16.4 Performance

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| End-to-end investigation time | < 4 hours per table | Timer from intake to report |
| RA lineage extraction time | < 30 min per table (with DB access) | Timer |
| Diagnostic query execution | < 2 min per query | Query duration logging |

### 16.5 Validation plan

1. **Phase 1 — Historical replay:** Run agent on WorkOrder and Invoice cases. Compare agent outputs to human-produced outputs from previous sessions.
2. **Phase 2 — Parallel run:** Run agent alongside human on next new table investigation. Compare results and timing.
3. **Phase 3 — Supervised autonomous:** Agent runs independently; human reviews all outputs before any action is taken.
4. **Phase 4 — Full autonomous with gates:** Agent runs independently with human approval only at defined gate points.

---

## Appendix A: Templates

### A.1 Investigation Report Template

```markdown
# Data Parity Investigation Report

**Table:** [GCP table name] vs [RA table name]
**Date:** [date]
**Investigator:** AI Parity Agent v[version]
**Reviewer:** [human name]
**Status:** Draft / Under Review / Approved

## 1. Executive Summary
[1-2 paragraphs summarizing total mismatches found, root causes, and proposed actions]

## 2. Scope
- **GCP Dataset:** [project.dataset.table]
- **RA Table:** [database.schema.table]
- **GCP Procedure:** [procedure name and version]
- **RA Procedure:** [procedure name and version]
- **Parity Test Run:** [test run ID and date]
- **Sample PMCID:** [if applicable]
- **Sample PropertyID:** [if applicable]

## 3. Column-Level Findings

### 3.1 [Column Name]

**Classification:** [format / join filter / cross-scope / column sourcing / calculation / data-level / sourcing gap / ETL timing / dedup]
**Severity:** [Critical / High / Medium / Low / Info]
**Affected rows:** [count or percentage]

#### Root Cause
[Explanation with code snippets from both sides]

#### Evidence
**GCP QA Query:**
```sql
[diagnostic query]
```
**Result:** [summary of results]

**RA Query:**
```sql
[diagnostic query]
```
**Result:** [summary of results]

#### Proposed Fix
**Before:**
```sql
[current code]
```
**After:**
```sql
[proposed code]
```

**Verification Query:**
```sql
[query to confirm fix]
```

**Risk Assessment:** [low/medium/high + blast radius]

---
[Repeat for each column]

## 4. Summary of Actions

| # | Column | Root Cause | Fix | Risk | Owner | Status |
|---|--------|-----------|-----|------|-------|--------|
| 1 | ... | ... | ... | ... | ... | Proposed |

## 5. Appendix
- Full lineage document: [link]
- Audit trail: [link]
- Parity test report: [link]
```

### A.2 Lineage Document Template

```markdown
# Data Lineage: [Table Name]

**Generated:** [date] by AI Parity Agent
**GCP Procedure:** [name] v[version]
**RA Procedure:** [name] v[version]

## Source-to-Target Column Mapping

| # | Target Column | GCP Source Expression | RA Source Expression | Match? | Notes |
|---|--------------|---------------------|---------------------|--------|-------|
| 1 | ... | ... | ... | Yes/No | ... |

## GCP ETL Flow

```
lz_onesite.OneSiteProperty_dbo_WorkOrder (raw source)
  → CREATE TEMP TABLE Temp_WorkOrder (main transformation)
    → JOIN cl_unified_pms.Employee (employee name lookup)
    → JOIN cl_unified_pms.CodeLookup (status mapping)
  → UPDATE Temp_WorkOrder (WOWorkGroup from ServiceRequestHistory)
  → UPDATE Temp_WorkOrder (MRActualWorkMinutes calculation)
  → MERGE cl_unified_pms.WorkOrder (final upsert)
```

## RA ETL Flow

```
Facilities.StagingWorkOrder (CDS extract)
  → Facilities.asp_MergeSourceWorkOrderIntoSource (dedup + staging)
    → Facilities.StagingSourceWorkOrder
  → Facilities.asp_MergeWorkOrderIntoStaging (main transformation)
    → Facilities.StagingDimWorkOrder (staging dim)
      → JOIN #Employee (employee name)
      → JOIN dbo.DimCodeLookup (status mapping)
    → MERGE dbo.DimWorkOrder (final merge)
    → UPDATE Step 10: encryption columns
    → UPDATE Step 11: WOActualWorkMinutes
    → UPDATE Step 12: MRActualWorkMinutes
    → UPDATE Step 12.1: NULL → 0 defaults
    → UPDATE Step 12.2: WOWorkGroup
    → UPDATE Step 13-14: OriginatingSystem, CompletionSource
```

## Join Dependencies

| Join | GCP ON Clause | RA ON Clause | Aligned? |
|------|--------------|-------------|----------|
| Employee (ActualCompletedBy) | RsEmployeeNb, PMCID, DeletedInd, UserDisableInd | osl_EmployeeNumber, PMCID, IsDeleted | NO |
| CodeLookup (Status) | PMCID, PropertyID, ClassName, CodeName, DeletedInd | PMCID, PropertyID, ClassName, CodeName, IsDeleted | YES |
| ... | ... | ... | ... |

## Downstream Consumers
- [List tables, views, reports that consume this table]
```

### A.3 Audit Log Entry Template

```json
{
  "timestamp": "2026-03-08T14:30:00Z",
  "agent_version": "1.0",
  "investigation_id": "INV-2026-0308-WO",
  "table": "cl_unified_pms.WorkOrder",
  "step": "diagnostic_query",
  "action": "execute_query",
  "platform": "bigquery_qa",
  "query": "SELECT ActualCompletedBy, RsWorkOrderId FROM ... WHERE ...",
  "result_row_count": 5,
  "result_summary": "All 5 rows show employee name instead of numeric ID",
  "decision": "Confirmed: column sourcing error (PAT-004 variant)",
  "confidence": 0.95,
  "human_approval_required": false,
  "human_approval_status": null,
  "next_step": "propose_fix"
}
```

### A.4 Developer Confirmation Message Template

```markdown
## Parity Fix — [Table].[Column]

**Ticket:** [ADO/Jira link]
**Priority:** [P1/P2/P3]

### Issue
[1-2 sentence description of the mismatch]

### Root Cause
[Brief root cause with code reference]

### Proposed Change
**File:** `ai_data_centralization/bigquery/.../sp_[Table]_upsert.sql`
**Line(s):** [line numbers]

Before:
```sql
[current code]
```

After:
```sql
[proposed code]
```

### Verification
After deploying to QA and running full reload:
```sql
[verification query that should return 0 rows]
```

### Impact
- Affected rows: [count]
- Downstream tables: [list]
- Risk: [low/medium/high]

### Request
Please review and approve the above change. Once deployed to QA, I will re-run the parity test to confirm resolution.
```

---

## Appendix B: Historical Case Library

### B.1 WorkOrder Cases (from debugging sessions)

| Case ID | Column | Root Cause Type | Root Cause Detail | Fix | Verified |
|---------|--------|----------------|-------------------|-----|----------|
| WO-001 | actualcompletedby | Column sourcing | GCP stores employee name instead of raw numeric ID | Change to `wo.woactualcompleteby` | Yes |
| WO-002 | actualcompletedbyemployee | Join filter | GCP has `UserDisableInd=0` not in RA | Remove `UserDisableInd=0` | Yes |
| WO-003 | createdbyemployee | Join filter | Same as WO-002 for `createdBy` employee join | Remove `UserDisableInd=0` | Yes |
| WO-004 | mractualworkminutes | Calculation | `DATE_DIFF` arg order + `ActualWorkOutDt` vs `ActualMoveOutDt` | Align arguments and date references | Yes |
| WO-005 | rstimerangeid | Column sourcing | Hardcoded `NULL AS RsTimeRangeId` | Change to `wo.TRID AS RsTimeRangeId` | Yes |
| WO-006 | status | Data-level | CodeLookup data divergence between GCP and RA | Investigate lookup table sync | In progress |
| WO-007 | woworkgroup | Dedup + sourcing | `ROW_NUMBER()` vs `MAX()` with NULL ties; RA missing PMCID in join | Align dedup; add PMCID to RA | In progress |

### B.2 Invoice Cases (from defect report)

| Case ID | Column | Root Cause Type | Root Cause Detail | Fix | Verified |
|---------|--------|----------------|-------------------|-----|----------|
| INV-001 | ApproverNm | Cross-PMC | user_id join missing cdspmcid → wrong person from wrong PMC | Add cdspmcid to join | Yes (v1.3) |
| INV-002 | RsCreatedByNm | Cross-PMC | Same as INV-001 for createdBy user profile join | Add cdspmcid to join | Yes (v1.3) |
| INV-003 | RsModifiedByNm | Cross-PMC | Same as INV-001 for modifiedBy user profile join | Add cdspmcid to join | Yes (v1.3) |
| INV-004 | RsLogTime (5 rows) | ETL timing | Stale lz data from incremental window miss | Full reload resolved | Yes |

---

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| **RA** | Reporting & Analytics — the SQL Server-based BI platform (source of truth) |
| **GCP** | Google Cloud Platform — the BigQuery-based target platform (migration) |
| **PMCID** | Property Management Company ID — top-level tenant identifier |
| **PropertyID** | Property identifier within a PMC |
| **lz** | Landing zone — raw source data extracted from OneSite into BigQuery |
| **cl_unified_pms** | Curated layer in BigQuery containing unified PMS dimension/fact tables |
| **CDS** | Common Data Service — the extract pipeline from source to staging |
| **SP** | Stored procedure |
| **Parity test** | Automated column-level comparison between RA and GCP tables |
| **SOT** | Source of truth (RA is SOT during migration) |
| **ETL** | Extract, Transform, Load |
| **MR** | Make Ready — work orders related to unit turnover |
| **SR** | Service Request — standard maintenance work orders |

---

*End of AI Agent Migration Brief*
