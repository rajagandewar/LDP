# WorkOrder Table — GCP vs RA Mismatch Investigation Specification

**Document Version:** 1.0  
**Date:** 2026-03-07  
**Author:** Raja Gandewar  
**Scope:** `cl_unified_pms.WorkOrder` (GCP BigQuery) vs `dbo.DimWorkOrder` (RA / SQL Server BI)

---

## Table of Contents

1. [Exported Context & Conversation Summary](#1-exported-context--conversation-summary)
2. [Detailed Agent Specification](#2-detailed-agent-specification)
3. [Permission & Access Matrix](#3-permission--access-matrix)
4. [Technology & Dependency List](#4-technology--dependency-list)
5. [Human-in-the-Loop Decision Map & Approval Workflow](#5-human-in-the-loop-decision-map--approval-workflow)
6. [Templates](#6-templates)
7. [RA-to-GCP Nomenclature Mapping](#7-ra-to-gcp-nomenclature-mapping)
8. [Memory / Standardization Items & Acceptance Criteria](#8-memory--standardization-items--acceptance-criteria)

---

## 1. Exported Context & Conversation Summary

### 1.1 Project Background

The Lumina Platform data centralization initiative migrates property management data from the RA (Reporting & Analytics) SQL Server BI environment to GCP BigQuery. The `WorkOrder` table is one of the largest and most complex tables in the Facilities domain.

- **GCP Target Table:** `cl_unified_pms.WorkOrder`
- **GCP Stored Procedure:** `cl_unified_pms.sp_WorkOrder_upsert`
- **RA Target Table:** `dbo.DimWorkOrder`
- **RA Stored Procedure:** `Facilities.asp_MergeWorkOrderIntoStaging`

Parity testing revealed mismatches in **7 actionable columns** out of 11 initially flagged. The remaining 4 were confirmed as matching or non-actionable after review.

### 1.2 Mismatch Summary — 7 Actionable Columns

| # | Column | Root Cause Category | Severity |
|---|--------|-------------------|----------|
| 1 | `ActualCompletedBy` | **Value-type mismatch** — GCP stores employee name (STRING via Employee join); RA stores numeric employee ID | High |
| 2 | `ActualCompletedByEmployee` | **Employee filter mismatch** — GCP adds `UserDisableInd=0` filter; RA only filters `IsDeleted <> 'Y'` | High |
| 3 | `CreatedByEmployee` | **Employee filter mismatch** — same `UserDisableInd=0` filter gap as column 2 | High |
| 4 | `MRActualWorkMinutes` | **DATE_DIFF argument order inverted** — BigQuery `DATE_DIFF(a, b, DAY)` computes `a − b`; SQL Server `DATEDIFF(DAY, a, b)` computes `b − a` | High |
| 5 | `RsTimeRangeId` | **Hardcoded NULL in GCP** — GCP initial code set `CAST(NULL AS STRING)` then never sourced `wo.TRID`; later fixed to `wo.TRID AS RsTimeRangeId` | Medium |
| 6 | `Status` | **Staging source data gap** — RA staging may have stale/missing status updates causing NULL; CodeLookup tables are in sync | Medium |
| 7 | `WOWorkGroup` | **Deduplication logic mismatch** — GCP uses `QUALIFY ROW_NUMBER() ... ORDER BY CreatedDate DESC`; RA uses `MAX(createdDate)` subquery which can pick a row with NULL `WorkGroupID` when ties exist | High |

### 1.3 Conversation Chronology

1. **Session 1** — User provided `GCP_lineage_WO.txt` (4,489 lines) and `RA_lineage_WO.txt` (2,639 lines). Initial lineage comparison performed for all 11 flagged columns. 4 columns confirmed as matching; 7 identified as actionable.

2. **Session 2** — Deep-dive into `ActualCompletedBy`: confirmed GCP resolves employee name via `Employee` table join while RA keeps the raw numeric ID. Identified the `UserDisableInd=0` filter gap for `ActualCompletedByEmployee` and `CreatedByEmployee`.

3. **Session 3** — Analysis of `MRActualWorkMinutes` argument order, `RsTimeRangeId` hardcoded NULL, `Status` staging gap, and `WOWorkGroup` `MAX(createdDate)` tie-breaking issue.

4. **Session 4** — Drafted debugging queries for each column, developer confirmation messages, and stepwise fix plans. User emphasized column-by-column approach with explicit approval gates.

5. **Session 5 (current)** — Consolidation of all findings into this specification document.

### 1.4 Key Design Differences (GCP vs RA)

| Aspect | GCP (BigQuery) | RA (SQL Server) |
|--------|---------------|-----------------|
| **Deduplication** | `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY createdate DESC) = 1` | CTE with `ROW_NUMBER()` and `DELETE WHERE Row_Number > 1` |
| **Employee Lookup** | Joins `cl_unified_pms.Employee` with `UserDisableInd=0` AND `DeletedInd=FALSE` | Joins `#Employee` temp table (decrypted from `dbo.DimEmployee`) with `IsDeleted <> 'Y'` only |
| **Employee Name** | `E.EmployeeNm` (plaintext from `cl_unified_pms.Employee`) | `DECRYPTBYKEY(osl_EmployeeNumber)` + `EmployeeName` (encrypted in `dbo.DimEmployee`) |
| **Date Math** | `DATE_DIFF(end, start, UNIT)` = `end − start` | `DATEDIFF(UNIT, start, end)` = `end − start` |
| **WorkGroup** | `QUALIFY ROW_NUMBER() ... ORDER BY srh.CreatedDate DESC` (deterministic, picks latest row) | `MAX(createdDate)` subquery (non-deterministic when ties exist; may pick NULL WorkGroupID row) |
| **Time Range** | `wo.TRID AS RsTimeRangeId` (now sourced; was previously hardcoded NULL) | `WO.TRID` flows through staging chain to `osl_TRID` |
| **Status Lookup** | `cl_unified_pms.CodeLookup` with `CodeLookUpClassNm = 'SRCurrentStatus'` | `dbo.DimCodeLookup` with `CodeLUClassName = 'SRCurrentStatus'` |
| **Encryption** | Not applicable (plaintext) | PII columns encrypted with symmetric key (`ENCRYPTBYKEY`/`DECRYPTBYKEY`) |

### 1.5 Lineage File Reference

| File | Lines | Content |
|------|-------|---------|
| `GCP_lineage_WO.txt` | 4,489 | Full `sp_WorkOrder_upsert` SQL, column mapping spreadsheet, dependent proc code (`sp_Property_upsert`, `sp_Employee_upsert` references), source object inventory |
| `RA_lineage_WO.txt` | 2,639 | Full `asp_MergeWorkOrderIntoStaging` SQL (v11.0), `asp_MergeSourceWorkOrderIntoSource` SQL, `asp_MergeSourceWorkOrderOnHoldIntoSource` SQL, table dependency chain, column mapping |
| `Invoice_Parity_Defect_Report.md` | 592 | Reference document showing completed parity analysis for Invoice table (`sp_Invoice_upsert`); serves as template for WorkOrder report |

---

## 2. Detailed Agent Specification

### 2.1 Purpose

Investigate, debug, and resolve data mismatches between the GCP BigQuery `cl_unified_pms.WorkOrder` table and the RA SQL Server `dbo.DimWorkOrder` table. The agent operates column-by-column with developer confirmation gates.

### 2.2 Inputs

| Input | Source | Format | Description |
|-------|--------|--------|-------------|
| GCP Lineage | `GCP_lineage_WO.txt` | Text/SQL | Full stored procedure code + column mapping for GCP side |
| RA Lineage | `RA_lineage_WO.txt` | Text/SQL | Full stored procedure code + column mapping for RA side |
| Test Results | HTML files in `Results/Run_1/` | HTML tables | Mismatch rows per property per column from parity test harness |
| GCP QA Data | `ai-data-platform-qa-5201.cl_unified_pms.WorkOrder` | BigQuery table | QA environment data for debugging queries |
| RA Source Data | `dbo.DimWorkOrder`, `Facilities.StagingSourceWorkOrder`, etc. | SQL Server tables | RA production data for cross-reference |
| Invoice Defect Report | `Invoice_Parity_Defect_Report.md` | Markdown | Template and reference for report format |

### 2.3 Outputs

| Output | Format | Description |
|--------|--------|-------------|
| Root Cause Analysis per column | Markdown section | Detailed explanation of why GCP and RA differ |
| Debugging Queries | SQL (BigQuery + T-SQL) | Verification queries for each root cause |
| Developer Confirmation Messages | Prose | Messages to send to dev team for approval before fix |
| Fix Code | SQL (BigQuery) | Corrected stored procedure code |
| Parity Defect Report | Markdown document | Final deliverable (modeled on Invoice report) |
| This Specification | Markdown document | Current document |

### 2.4 Use Cases

**UC-1: Column-by-Column Root Cause Analysis**
1. Compare GCP proc logic vs RA proc logic for the column in question
2. Identify the specific code divergence
3. Draft a root cause statement with line-level code citations
4. Draft debugging queries for both GCP QA and RA environments

**UC-2: Developer Confirmation Before Fix**
1. Present root cause + debugging queries to developer
2. Developer runs queries and confirms findings
3. Agent receives go-ahead or correction
4. Agent proceeds to next column or revises analysis

**UC-3: Fix Implementation**
1. Draft fix code for GCP stored procedure
2. Include before/after code comparison
3. Specify deployment steps (procedure update + full reload)
4. Define post-deployment verification queries

### 2.5 Workflow — Per Column

```
┌──────────────────────┐
│ 1. Lineage Comparison│
│    (GCP vs RA code)  │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 2. Root Cause Draft  │
│    + Debugging SQL   │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────┐
│ 3. HUMAN GATE: Dev confirms  │
│    root cause + query results│
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────┐
│ 4. Fix Code Draft    │
│    (before/after)    │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────┐
│ 5. HUMAN GATE: Dev approves  │
│    fix code for deployment   │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────┐
│ 6. Deploy + Reload   │
│    + Verify Parity   │
└──────────────────────┘
```

### 2.6 Column Processing Order

1. `ActualCompletedBy` — value-type mismatch (name vs ID)
2. `ActualCompletedByEmployee` — employee filter gap
3. `CreatedByEmployee` — employee filter gap (same root cause as #2)
4. `MRActualWorkMinutes` — DATE_DIFF argument order
5. `RsTimeRangeId` — hardcoded NULL
6. `Status` — staging data gap
7. `WOWorkGroup` — MAX(createdDate) tie-breaking

---

## 3. Permission & Access Matrix

### 3.1 Environment Access

| Environment | Project / Server | Access Level Required | Who Needs It |
|-------------|-----------------|----------------------|-------------|
| GCP QA BigQuery | `ai-data-platform-qa-5201` | `bigquery.dataEditor` on `cl_unified_pms`, `scratch` datasets | Developer, QA Analyst |
| GCP PROD BigQuery | `ai-data-platform-prod` | `bigquery.dataViewer` for debugging; `bigquery.dataEditor` for deployment | Developer (viewer), Lead/DBA (editor) |
| GCP LZ BigQuery | `ai-data-platform-prod.lz_onesite` | `bigquery.dataViewer` | Developer, QA Analyst |
| RA SQL Server | BI database (Facilities, dbo schemas) | `SELECT` on staging/source/dim tables; `EXECUTE` on stored procs | Developer, QA Analyst |
| Source SQL Server | OneSiteProperty database | `SELECT` on views (e.g., `OneSiteProperty.vwWorkOrder`) | ETL Service Account |

### 3.2 Table-Level Permissions

| Table/Dataset | Read | Write | Execute | Notes |
|--------------|------|-------|---------|-------|
| `cl_unified_pms.WorkOrder` | Dev, QA | Lead only (via proc) | N/A | MERGE target |
| `cl_unified_pms.sp_WorkOrder_upsert` | Dev, QA | Lead/DBA | Lead/DBA | Procedure definition |
| `lz_onesite.OneSiteProperty_dbo_*` | Dev, QA | ETL Service Account | N/A | Landing zone — read-only for analysis |
| `cl_unified_pms.Employee` | Dev, QA | Lead only (via proc) | N/A | Employee dimension |
| `dbo.DimWorkOrder` (RA) | Dev, QA | ETL Service Account | N/A | RA target table |
| `Facilities.StagingSourceWorkOrder` (RA) | Dev, QA | ETL Service Account | N/A | RA staging |
| `dbo.DimEmployee` (RA) | Dev, QA | ETL Service Account | N/A | Encrypted PII — requires symmetric key |

### 3.3 Encryption / PII Access

| System | Encryption | Key Management | Access Protocol |
|--------|-----------|----------------|-----------------|
| RA SQL Server | Symmetric key encryption on `DimEmployee.EmployeeName`, `osl_EmployeeNumber`, `WorkOrderTechnicianAssigned` | `Admin.OpenSymmetricKey` / `Admin.CloseSymmetricKey` | Must OPEN key before querying PII columns; CLOSE after |
| GCP BigQuery | No encryption on employee fields (plaintext `EmployeeNm` in `cl_unified_pms.Employee`) | N/A | Standard BigQuery IAM |

---

## 4. Technology & Dependency List

### 4.1 Platforms

| Component | Technology | Version/Details |
|-----------|-----------|-----------------|
| **GCP Data Warehouse** | Google BigQuery | Standard SQL dialect |
| **RA Data Warehouse** | Microsoft SQL Server | T-SQL, BI database |
| **Landing Zone** | BigQuery datasets (`lz_onesite`, `lz_ao`) | Replicated from SQL Server via CDS ETL |
| **Source System** | OneSite Property Management | SQL Server views (`OneSiteProperty.vwWorkOrder`) |
| **CI/CD** | Azure DevOps Pipelines | `azure-pipelines-1.yml`, `azure-pipelines-prod.yml` |
| **Repository** | Git (Azure DevOps) | `Lumina Platform/ai_data_centralization/` |

### 4.2 GCP Stored Procedure Dependencies

**`cl_unified_pms.sp_WorkOrder_upsert`** depends on:

| Dependency | Type | Purpose |
|-----------|------|---------|
| `cl_unified_pms.tf_CheckLastRunStatus` | Table Function | Prevents concurrent execution |
| `cl_unified_pms.sp_LogRunStatus` | Procedure | ETL execution logging |
| `cl_unified_pms.sp_GetDateBoundary` | Procedure | Calculates incremental date window |
| `cl_unified_pms.udf_GetPropertyManagementSourceKey` | UDF | Returns PMS source key for 'OS' |
| `cl_unified_pms.udf_GetDeletedInd` | UDF | Converts `cdsextracttype` to boolean |
| `cl_unified_pms.Property` | Table | Property dimension |
| `cl_unified_pms.Unit` | Table | Unit dimension |
| `cl_unified_pms.Building` | Table | Building dimension |
| `cl_unified_pms.ServiceRequest` | Table | Service request dimension |
| `cl_unified_pms.Lease` | Table | Lease facts (for MoveOutDt, MR calculations) |
| `cl_unified_pms.Employee` | Table | Employee dimension (name lookup) |
| `cl_unified_pms.CodeLookup` | Table | Code-to-display-name mapping |
| `cl_unified_pms.StandardCalendar` | Table | Calendar dimension for day/minute calculations |
| `lz_onesite.OneSiteProperty_dbo_WorkOrder` | LZ Table | Primary source |
| `lz_onesite.OneSiteProperty_dbo_WorkOrderOnHold` | LZ Table | On-hold periods |
| `lz_onesite.OneSiteProperty_dbo_WOPriority` | LZ Table | Priority settings |
| `lz_onesite.OneSiteProperty_dbo_ProblemSpec` | LZ Table | Problem specification |
| `lz_onesite.OneSiteProperty_dbo_ProblemItem` | LZ Table | Problem items |
| `lz_onesite.OneSiteProperty_dbo_ProblemCategory` | LZ Table | Problem categories |
| `lz_onesite.OneSiteProperty_dbo_ProblemCategoryType` | LZ Table | Category types |
| `lz_onesite.OneSiteProperty_dbo_SiteEmployeeTable` | LZ Table | Technician assignment |
| `lz_onesite.OneSiteProperty_dbo_IssueLocations` | LZ Table | WO location description |
| `lz_onesite.OneSiteProperty_dbo_ServiceRequestStatusReason` | LZ Table | Status reasons |
| `lz_onesite.OneSiteProperty_dbo_ServiceRequestHistory` | LZ Table | WorkGroup + Originating/Completion source |
| `lz_onesite.OneSiteProperty_dbo_WorkGroup` | LZ Table | WorkGroup name lookup |
| `lz_onesite.OneSiteProperty_dbo_WOHolidays` | LZ Table | Holiday exclusion dates |

### 4.3 RA Stored Procedure Dependencies

**`Facilities.asp_MergeWorkOrderIntoStaging`** depends on:

| Dependency | Type | Purpose |
|-----------|------|---------|
| `Admin.asp_ETLProcessLog` | Procedure | Step-level ETL logging |
| `Admin.OpenSymmetricKey` / `CloseSymmetricKey` | Procedures | PII encryption key management |
| `dbo.udfGetPropertyList` | Function | Returns active properties for processing |
| `dbo.DimEmployee` | Table | Employee dimension (encrypted) |
| `dbo.DimProperty` | Table | Property dimension |
| `dbo.DimUnit` | Table | Unit dimension |
| `dbo.DimBuilding` | Table | Building dimension |
| `dbo.DimCodeLookup` | Table | Code-to-display-name mapping |
| `dbo.DimStandardCalendar` | Table | Calendar dimension |
| `dbo.FactLease` + `dbo.DimLeaseAttributes` | Tables | Lease data for MR calculations |
| `dbo.DimServiceRequest` | Table | Service request dimension |
| `Facilities.StagingSourceWorkOrder` | Table | Source staging (from `asp_MergeSourceWorkOrderIntoSource`) |
| `Facilities.StagingSourceWorkOrderOnHold` | Table | On-hold staging |
| `Facilities.StagingSourceWOPriority` | Table | Priority staging |
| `Facilities.StagingSourceSRStatus` | Table | SR status staging |
| `Facilities.StagingSourceProblemSpec` | Table | Problem spec staging |
| `Facilities.StagingSourceProblemItem` | Table | Problem item staging |
| `Facilities.StagingSourceProblemCategory` | Table | Problem category staging |
| `Facilities.StagingSourceProblemCategoryType` | Table | Category type staging |
| `Facilities.StagingSourceIssueLocations` | Table | Issue locations staging |
| `Facilities.StagingSourceWOHolidays` | Table | Holiday staging |
| `Facilities.SourceServiceRequestHistory` | Table | SR history (WorkGroup, OriginatingSystem) |
| `Facilities.SourceWorkGroup` | Table | WorkGroup name lookup |
| `Facilities.SourceSiteEmployeeTable` | Table | Site employee staging |

### 4.4 Temp Tables Created During Execution

| System | Temp Table | Purpose |
|--------|-----------|---------|
| GCP | `Temp_WorkOrder` | Main working set |
| GCP | `TempMoveOutDts` | MR ActualMoveOutDt resolution |
| GCP | `Temp_SR_ase` | WorkGroup resolution via ServiceRequestHistory |
| GCP | `Temp_SR_WoIDs` | Min/Max WOID per ServiceRequest |
| GCP | `Temp_RequestActionCodeName_1/3/4` | OriginatingSystem, CompletionSource, CancelledSource |
| RA | `#Employee` | Decrypted employee temp table |
| RA | `#PropertyList` | Active properties for current run |
| RA | `Facilities.StagingWOOnHold` | On-hold staging helper |
| RA | `Facilities.StagingDimBuilding` | Building staging helper |
| RA | `Facilities.StagingDimWorkOrder` | Main intermediate staging |
| RA | `#tmp_SR_WoIDs` | Min/Max WOID per ServiceRequest |
| RA | `#tmp_RequestActionCodeName_1/3/4` | OriginatingSystem, CompletionSource, CancelledSource |

---

## 5. Human-in-the-Loop Decision Map & Approval Workflow

### 5.1 Decision Gates

Every column investigation passes through **two mandatory human gates** before a fix is deployed:

```
GATE 1: Root Cause Confirmation
├── Agent presents: root cause statement + debugging queries
├── Developer runs queries against GCP QA + RA
├── Developer responds: CONFIRMED / NEEDS REVISION / NOT A BUG
│   ├── CONFIRMED → proceed to Gate 2
│   ├── NEEDS REVISION → agent revises analysis, re-presents
│   └── NOT A BUG → column marked as resolved (no fix needed)

GATE 2: Fix Approval
├── Agent presents: before/after code diff + deployment steps
├── Developer + Lead review
├── Responses: APPROVED / MODIFY / REJECT
│   ├── APPROVED → deploy to QA, run parity test, then deploy to PROD
│   ├── MODIFY → agent revises fix, re-presents
│   └── REJECT → column escalated to architecture review
```

### 5.2 Open Questions Requiring Human Decision

| # | Question | Column(s) Affected | Decision Needed From |
|---|----------|-------------------|---------------------|
| 1 | Should `ActualCompletedBy` store the numeric ID (RA behavior) or employee name (current GCP behavior)? | `ActualCompletedBy` | Product Owner / Data Architect |
| 2 | Should GCP add `UserDisableInd=0` filter or should it be removed to match RA? | `ActualCompletedByEmployee`, `CreatedByEmployee` | Data Architect |
| 3 | Is the RA `Status` NULL a known data quality issue in staging, or should GCP replicate the NULL? | `Status` | RA ETL Team |
| 4 | Should GCP `WOWorkGroup` logic use `MAX(createdDate)` to match RA, or keep `ROW_NUMBER()` as the correct approach? | `WOWorkGroup` | Data Architect |
| 5 | For `ActualCompletedBy`, should GCP return 0 when no employee match exists (RA behavior) or NULL? | `ActualCompletedBy` | Data Architect |

### 5.3 Escalation Matrix

| Severity | Condition | Escalation Target | SLA |
|----------|----------|-------------------|-----|
| **P1** | >10% of rows affected, business-critical column | Lead Developer + Data Architect | 1 business day |
| **P2** | <10% of rows affected, or non-critical column | Lead Developer | 3 business days |
| **P3** | Cosmetic / naming / formatting difference only | Developer | Next sprint |
| **P4** | Known RA limitation, GCP is correct by design | Document only, no fix | N/A |

---

## 6. Templates

### 6.1 Lineage Documentation Template

```markdown
# [Table Name] — Lineage Document

## GCP Side
- **Target Table:** `cl_unified_pms.[TableName]`
- **Stored Procedure:** `cl_unified_pms.sp_[TableName]_upsert`
- **Source Tables:** [list]
- **Temp Tables:** [list]
- **Key Joins:** [describe join logic for each dimension lookup]
- **Deduplication:** [describe QUALIFY/ROW_NUMBER logic]
- **Incremental Window:** `cdssourcelogtime >= beginDate AND cdssourcelogtime < endDate`

## RA Side
- **Target Table:** `dbo.Dim[TableName]`
- **Stored Procedure:** `Facilities.asp_Merge[TableName]IntoStaging`
- **Upstream Procs:** [list source-to-staging procs]
- **Source Tables:** [list]
- **Temp Tables:** [list]
- **Key Joins:** [describe join logic]
- **Deduplication:** [describe CTE/DELETE logic]
- **Incremental Window:** `CDSExtractDate BETWEEN FactStartDate AND LastLoadDate`

## Column-Level Mapping
| GCP Column | RA Column | GCP Source Expression | RA Source Expression | Match? |
|------------|-----------|----------------------|---------------------|--------|
| [col] | [col] | [expr] | [expr] | Y/N |
```

### 6.2 Investigation Report Template (Per Column)

```markdown
# [ColumnName] — Mismatch Investigation Report

## Root Cause
[1-2 sentence summary]

## GCP Logic
```sql
-- File: GCP_lineage_WO.txt, lines X-Y
[relevant GCP code snippet]
```

## RA Logic
```sql
-- File: RA_lineage_WO.txt, lines X-Y
[relevant RA code snippet]
```

## Code Divergence
[Detailed explanation of what differs and why it causes the mismatch]

## Debugging Queries

### GCP QA Query
```sql
[BigQuery SQL to verify root cause in GCP QA environment]
```

### RA Query
```sql
[T-SQL to verify root cause in RA environment]
```

## Developer Confirmation Message
> [Copy-paste message for developer with findings and ask for confirmation]

## Proposed Fix
### Before (current GCP code)
```sql
[current code]
```

### After (fixed GCP code)
```sql
[fixed code]
```

## Deployment Steps
1. Deploy updated procedure definition to [environment]
2. Run full historical reload: `CALL cl_unified_pms.sp_WorkOrder_upsert(...)` 
3. Run parity verification query

## Verification Query
```sql
[post-fix parity check SQL]
```

## Status
- [ ] Root cause confirmed (Gate 1)
- [ ] Fix approved (Gate 2)
- [ ] Deployed to QA
- [ ] QA parity verified
- [ ] Deployed to PROD
- [ ] PROD parity verified
```

### 6.3 Audit Log Template

```markdown
# WorkOrder Parity Fix — Audit Log

| Date | Action | Column | Actor | Gate | Outcome | Notes |
|------|--------|--------|-------|------|---------|-------|
| YYYY-MM-DD | Root cause presented | [col] | [agent] | Gate 1 | Pending | [link to investigation] |
| YYYY-MM-DD | Dev confirmed | [col] | [dev name] | Gate 1 | Confirmed | [query results summary] |
| YYYY-MM-DD | Fix code presented | [col] | [agent] | Gate 2 | Pending | [link to diff] |
| YYYY-MM-DD | Fix approved | [col] | [lead name] | Gate 2 | Approved | |
| YYYY-MM-DD | Deployed to QA | [col] | [dev name] | — | Success | |
| YYYY-MM-DD | QA parity verified | [col] | [qa name] | — | 0 diffs | [query + results] |
| YYYY-MM-DD | Deployed to PROD | [col] | [lead name] | — | Success | Full reload run |
| YYYY-MM-DD | PROD parity verified | [col] | [qa name] | — | 0 diffs | |
```

---

## 7. RA-to-GCP Nomenclature Mapping

### 7.1 Column Name Mapping

| GCP Column (`cl_unified_pms.WorkOrder`) | RA Column (`dbo.DimWorkOrder`) | Notes |
|-----------------------------------------|-------------------------------|-------|
| `PropertyKey` | `PropertyKey` | Same |
| `PropertyManagementSourceKey` | *(not stored — derived at query time)* | GCP-only via UDF |
| `UnitKey` | `UnitKey` | Same; RA defaults to `-1` if NULL, GCP uses NULL |
| `BuildingKey` | `BuildingKey` | Same; RA defaults to `-1` if NULL |
| `SequenceCnt` | `SequenceCount` | Name difference only |
| `WorkOrderComments` | `Comments` | Name difference only |
| `MustCompleteDt` | `MustCompleteDate` | Name + type (GCP STRING, RA DATETIME) |
| `ReworkInd` | `ReworkBit` | Name difference; GCP BOOL, RA BIT |
| `ReworkReason` | `ReworkReason` | Same |
| `WorkOrderCancelDt` | `CancelDate` | Name difference |
| `WorkOrderCancelBy` | `CancelBy` | Name difference |
| `WOLocation` | `WOLocation` | Same; RA sets NULL in MERGE Step 9 |
| `LastModifiedBy` | `LastModifiedBy` | Same |
| `ActualCompletedDt` | `ActualCompletedDate` | Name difference |
| **`ActualCompletedBy`** | **`ActualCompletedBy`** | **MISMATCH: GCP=EmployeeNm (STRING), RA=numeric ID** |
| `CompleteTm` | `CompleteTime` | Name difference |
| `OnHoldDt` | `OnHoldDate` | Name difference |
| `RespondedDt` | `RespondedDate` | Name difference |
| `RespondeDt` | `RespondedTime` | Name difference (GCP has typo: `RespondeDt`) |
| `UpdateSource` | `UpdateSource` | Same |
| `SRType` | `SRType` | Same |
| `WOPriorityDsc` | `WOPriorityDesc` | Name difference; both apply `INITCAP`/`[dbo].[InitCap]` |
| `WOCompleteWithin` | `WOCompleteWithin` | Same |
| `PsDsc` | `psDescription` | Name difference |
| `PsHWS` | `psHWS` | Same; both resolve via CodeLookup |
| `Status` | `Status` | **MISMATCH: RA staging gap may leave NULL** |
| `StatusReason` | `StatusReason` | Same |
| `StatusReasonOutsideOfManagementControlInd` | `StatusReasonOutsideOfManagementControlBit` | Name + type (BOOL vs BIT) |
| `ProblemItemNm` | `ProblemItemName` | Name difference |
| `ProblemCategory` | `ProblemCategory` | Same |
| `ProblemCategoryType` | `ProblemCategoryType` | Same |
| `ProblemCategoryTypeDsc` | `ProblemCategoryTypeDescription` | Name difference |
| **`CreatedByEmployee`** | **`CreatedByEmployee`** | **MISMATCH: GCP filter includes `UserDisableInd=0`** |
| **`ActualCompletedByEmployee`** | **`ActualCompletedByEmployee`** | **MISMATCH: GCP filter includes `UserDisableInd=0`** |
| `StatusCd` | `StatusCode` | Name difference |
| `MakeReadyInd` | `MakeReadyFlag` | Name + type (BOOL vs INT 0/1) |
| `WoOHOnHoldStartDt` | `woOHOnHoldStart` | Name difference |
| `WoOHOnHoldEndDt` | `woOHOnHoldEnd` | Name difference |
| `ExcludeWeekEndDaysCnt` | `ExcludeWeekEndDaysCount` | Name difference |
| `OnHoldDaysCnt` | `OnHoldDaysCount` | Name difference |
| `HolidayCnt` | `HolidayCount` | Name difference |
| `WOActualWorkMinutes` | `WOActualWorkMinutes` | Same |
| **`MRActualWorkMinutes`** | **`MRActualWorkMinutes`** | **MISMATCH: DATE_DIFF argument order** |
| `ServiceComments` | `ServiceComments` | Same |
| `SetID` | `setID` | Same |
| `WorkOrderTechnicianAssigned` | `WorkOrderTechnicianAssigned` | RA sets NULL in MERGE Step 9; updated in Step 10 |
| **`WOWorkGroup`** | **`WOWorkGroup`** | **MISMATCH: deduplication logic** |
| `WoOriginatingSystem` | `woOriginatingSystem` | Same logic |
| `WoCompletionSource` | `woCompletionSource` | Same logic |
| `ScheduledForDt` | `ScheduledFor` | Name difference |
| `RsCreateDt` | `CreateDate` | Name difference |
| `RsCreatedBy` | `CreatedBy` | Name difference |
| `RsModifiedDt` | `ModifiedDate` | Name difference |
| `RsWorkOrderId` | `osl_WOID` | **Prefix difference: `Rs` vs `osl_`** |
| `RsServiceRequestId` | `osl_SRID` | **Prefix difference** |
| `RsWorkOrderPID` | `osl_WOPID` | **Prefix difference** |
| **`RsTimeRangeId`** | **`osl_TRID`** | **MISMATCH: was hardcoded NULL in GCP; prefix difference** |
| `RsPMCId` | `osl_PMCID` | **Prefix difference** |
| `RsPropertyId` | `osl_PropertyID` | **Prefix difference** |
| `RsLogTime` | *(not in DimWorkOrder)* | GCP-only; `TIMESTAMP_SECONDS(cdssourcelogtime)` |
| `ETLModifiedDtm` | `RecordModifiedDate` | Name difference |
| `DeletedInd` | `IsDeleted` | Type (BOOL vs CHAR 'Y'/'N') |

### 7.2 Prefix Convention

| System | ID Column Prefix | Example |
|--------|-----------------|---------|
| GCP (`cl_unified_pms`) | `Rs` | `RsWorkOrderId`, `RsPropertyId`, `RsPMCId` |
| RA (`dbo.DimWorkOrder`) | `osl_` | `osl_WOID`, `osl_PropertyID`, `osl_PMCID` |

### 7.3 Table Name Mapping

| GCP Table | RA Equivalent |
|-----------|--------------|
| `cl_unified_pms.WorkOrder` | `dbo.DimWorkOrder` |
| `cl_unified_pms.Employee` | `dbo.DimEmployee` |
| `cl_unified_pms.Property` | `dbo.DimProperty` |
| `cl_unified_pms.Unit` | `dbo.DimUnit` |
| `cl_unified_pms.Building` | `dbo.DimBuilding` |
| `cl_unified_pms.CodeLookup` | `dbo.DimCodeLookup` |
| `cl_unified_pms.ServiceRequest` | `dbo.DimServiceRequest` |
| `cl_unified_pms.Lease` | `dbo.FactLease` + `dbo.DimLeaseAttributes` |
| `cl_unified_pms.StandardCalendar` | `dbo.DimStandardCalendar` |
| `lz_onesite.OneSiteProperty_dbo_WorkOrder` | `Facilities.StagingWorkOrder` → `Facilities.StagingSourceWorkOrder` |
| `lz_onesite.OneSiteProperty_dbo_ServiceRequestHistory` | `Facilities.SourceServiceRequestHistory` |
| `lz_onesite.OneSiteProperty_dbo_WorkGroup` | `Facilities.SourceWorkGroup` |

### 7.4 Stored Procedure Mapping

| GCP Procedure | RA Procedure(s) | Notes |
|--------------|-----------------|-------|
| `cl_unified_pms.sp_WorkOrder_upsert` | `Facilities.asp_MergeSourceWorkOrderIntoSource` → `Facilities.asp_MergeWorkOrderIntoStaging` | GCP is single proc; RA is multi-stage pipeline |
| `cl_unified_pms.sp_Employee_upsert` | `dbo.asp_MergeDimEmployee` | Employee dimension load |
| `cl_unified_pms.sp_Property_upsert` | *(RA property load procs)* | Property dimension |

---

## 8. Memory / Standardization Items & Acceptance Criteria

### 8.1 Standardization Rules (Carry Forward)

These rules should be applied to all future table migration parity analyses:

1. **Always compare join filters** — Check for extra/missing filters (e.g., `UserDisableInd`, `IsDeleted`, `RowIsCurrent`) between GCP and RA employee/dimension joins.

2. **Always verify DATE_DIFF argument order** — BigQuery `DATE_DIFF(end, start, part)` vs SQL Server `DATEDIFF(part, start, end)`. Both return `end − start`, but argument positions are swapped.

3. **Always check for hardcoded NULLs** — When GCP initializes columns as `CAST(NULL AS TYPE)` in the main SELECT, verify a subsequent UPDATE populates them (e.g., `RsTimeRangeId`, `WOWorkGroup`, `WoOriginatingSystem`, `WoCompletionSource`).

4. **Always compare deduplication logic** — `QUALIFY ROW_NUMBER()` (GCP) vs `MAX()`/CTE-based (RA). Check for tie-breaking determinism.

5. **Always check value-type alignment** — Confirm that columns store the same semantic value (e.g., numeric ID vs resolved name).

6. **RA uses `osl_` prefix; GCP uses `Rs` prefix** — Map accordingly in all queries.

7. **RA encrypts PII** — Employee names in RA require `DECRYPTBYKEY()`. GCP stores plaintext.

8. **RA uses multi-stage pipeline** — Source → StagingSource → StagingDim → Dim. GCP does it in a single procedure with temp tables. Always trace the full chain in RA.

### 8.2 Acceptance Criteria — Per Column

For each of the 7 mismatched columns, the fix is accepted when ALL of the following are true:

| # | Criterion | Verification Method |
|---|-----------|-------------------|
| 1 | Root cause confirmed by developer | Gate 1 sign-off |
| 2 | Fix code reviewed and approved | Gate 2 sign-off |
| 3 | Fix deployed to GCP QA | QA procedure execution log shows `Complete` |
| 4 | QA parity test shows 0 diffs for this column | Parity query returns `column_diffs = 0` |
| 5 | Fix deployed to GCP PROD | PROD procedure execution log shows `Complete` |
| 6 | Full historical reload executed in PROD | ETL log confirms full date range processed |
| 7 | PROD parity test shows 0 diffs for this column | Parity query returns `column_diffs = 0` |
| 8 | No regression in other columns | Full parity test shows no new diffs introduced |

### 8.3 Acceptance Criteria — Overall WorkOrder Table

| # | Criterion | Target |
|---|-----------|--------|
| 1 | All 7 actionable columns fixed and verified | 7/7 columns at 0 diffs |
| 2 | No new mismatches introduced | Full-column parity scan clean |
| 3 | Defect report document completed | Markdown document reviewed and filed |
| 4 | Audit log complete | All gate sign-offs recorded |
| 5 | Procedure version updated in header | Version history block updated with fix description |
| 6 | TFS work item updated | All linked items moved to Resolved/Closed |

### 8.4 Parity Verification Query Template

```sql
-- Run after PROD full reload to verify all 7 columns
SELECT
  COUNT(*) AS total_rows,
  COUNTIF(gcp.ActualCompletedBy         IS DISTINCT FROM CAST(ra.ActualCompletedBy AS STRING))  AS actualcompletedby_diffs,
  COUNTIF(gcp.ActualCompletedByEmployee IS DISTINCT FROM ra.ActualCompletedByEmployee)          AS actualcompletedbyemp_diffs,
  COUNTIF(gcp.CreatedByEmployee         IS DISTINCT FROM ra.CreatedByEmployee)                  AS createdbyemp_diffs,
  COUNTIF(gcp.MRActualWorkMinutes       IS DISTINCT FROM ra.MRActualWorkMinutes)                AS mractualworkmin_diffs,
  COUNTIF(gcp.RsTimeRangeId            IS DISTINCT FROM CAST(ra.osl_TRID AS NUMERIC))          AS rstimerangeid_diffs,
  COUNTIF(gcp.Status                    IS DISTINCT FROM ra.Status)                             AS status_diffs,
  COUNTIF(gcp.WOWorkGroup              IS DISTINCT FROM ra.WOWorkGroup)                        AS woworkgroup_diffs
FROM `ai-data-platform-prod.cl_unified_pms.WorkOrder` gcp
JOIN [dbo].[DimWorkOrder] ra  -- (cross-platform; adapt for actual execution environment)
  ON gcp.RsWorkOrderId = ra.osl_WOID
  AND gcp.RsPropertyId = ra.osl_PropertyID
  AND gcp.RsPMCId      = ra.osl_PMCID
WHERE gcp.DeletedInd = FALSE
  AND ra.IsDeleted <> 'Y';
```

> **Note:** This query is conceptual — actual execution requires either a cross-platform tool or exporting one side to the other's environment.

### 8.5 Detailed Root Cause Reference — Per Column

#### 8.5.1 ActualCompletedBy

- **GCP Code (line 53):** `E.EmployeeNm AS ActualCompletedBy` — resolves to employee name string
- **RA Code (Step 5, line 518):** `WO.ActualCompletedBy` — keeps raw numeric `woactualcompleteby` ID
- **Fix Direction:** Align GCP to store numeric ID like RA, OR document as intentional enrichment. Requires Product Owner decision.

#### 8.5.2 ActualCompletedByEmployee & CreatedByEmployee

- **GCP Code (lines 140-151):** Employee join includes `E.UserDisableInd = 0`
- **RA Code (lines 581-582):** `#Employee` join only checks `EAC.IsDeleted <> 'Y'` — no `UserDisableBit` filter
- **Impact:** GCP returns NULL for disabled employees; RA still returns their name
- **Fix Direction:** Remove `UserDisableInd=0` from GCP joins to match RA behavior, OR confirm RA should also exclude disabled employees

#### 8.5.3 MRActualWorkMinutes

- **GCP Code (lines 451-468):** `TIMESTAMP_DIFF(ActualCompletedDt, COALESCE(ActualMoveOutDt, RsCreateDt), MINUTE)` = completed − moveout
- **RA Code (lines 1138-1141):** `DATEDIFF_BIG(MINUTE, COALESCE(l.ActualMoveOutDate,WO.CreateDate), ISNULL(WO.ActualCompletedDate,@gd))` = completed − moveout
- **Both are semantically equivalent** (`end − start`). The previously identified "inverted argument order" bug was in an earlier version and has been fixed in the current GCP code (version 2025-09-30 fix by Narsingarao N). **Verify with current deployed code.**

#### 8.5.4 RsTimeRangeId

- **GCP Code (line 106):** `wo.TRID AS RsTimeRangeId` — now correctly sourced
- **Earlier GCP Code:** `CAST(NULL AS STRING) AS RsTimeRangeId` — was hardcoded NULL
- **RA Code (line 544, 995):** `WO.TRID` → `l.osl_TRID` — always sourced
- **Fix Direction:** Confirmed fixed in latest GCP version. Verify deployment status.

#### 8.5.5 Status

- **GCP Code (lines 67, 134-139):** `CL.CodeLookUpDisplayNm AS Status` via join to `cl_unified_pms.CodeLookup` on `CodeLookUpClassNm = 'SRCurrentStatus'`
- **RA Code (lines 531, 575):** `CL.CodeLUDisplayName AS Status` via join to `dbo.DimCodeLookup` on `CodeLUClassName = 'SRCurrentStatus'`
- **Root Cause:** Logic is equivalent. Mismatches likely due to RA staging data freshness (stale `StagingSourceWorkOrder` rows with outdated `StatusCode` that don't yet have matching CodeLookup entries).
- **Fix Direction:** Confirm with RA ETL team whether staging gap is known.

#### 8.5.6 WOWorkGroup

- **GCP Code (lines 495-516):** Uses `Temp_SR_ase` with `QUALIFY ROW_NUMBER() ... ORDER BY srh.CreatedDate DESC` — deterministic latest row
- **RA Code (lines 1169-1183):** Uses `MAX(createdDate)` subquery — when multiple rows share the same max `createdDate`, the join is non-deterministic and may pick a row with `NULL` WorkGroupID
- **Fix Direction:** This is an RA-side issue. GCP logic is more robust. Document for RA team awareness; no GCP fix needed.

---

## Appendix A: File Inventory

| File | Path | Purpose |
|------|------|---------|
| `GCP_lineage_WO.txt` | `c:\Users\rgandewar\Downloads\workorder\` | GCP-side lineage and full procedure code |
| `RA_lineage_WO.txt` | `c:\Users\rgandewar\Downloads\workorder\` | RA-side lineage and full procedure code |
| `Invoice_Parity_Defect_Report.md` | `c:\Users\rgandewar\Downloads\workorder\` | Reference defect report template (Invoice table) |
| `GCP_lineage_WO.pdf` | `c:\Users\rgandewar\Downloads\workorder\` | PDF version of GCP lineage |
| `PROD_INVOICE.csv` | `c:\Users\rgandewar\Downloads\workorder\` | PROD Invoice extract (reference) |
| `PROD_IN_QA_INVOICE.csv` | `c:\Users\rgandewar\Downloads\workorder\` | QA Invoice extract (reference) |
| Test Results HTML | `02Mar2026_171750/Results/Run_1/` | Parity test result pages |

## Appendix B: Version History of This Document

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-07 | Raja Gandewar | Initial specification covering all 8 sections |

---

*Document compiled from multi-session analysis of WorkOrder GCP↔RA parity mismatches.*
