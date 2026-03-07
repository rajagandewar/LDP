# RA-GCP Nomenclature Mapping Reference

**Version:** 1.0  
**Date:** 2026-03-08  
**Purpose:** Canonical mapping between RA (SQL Server/BI) and GCP (BigQuery) naming conventions for use by the AI Parity Agent and human analysts.

---

## 1. Database-Level Mapping

| Concept | GCP (BigQuery) | RA (SQL Server) |
|---------|---------------|-----------------|
| Project | `ai-data-platform-prod` / `ai-data-platform-qa-5201` | N/A (single server) |
| Curated dataset | `cl_unified_pms` | `dbo` (dimensions/facts), `Facilities` (staging) |
| Landing zone dataset | `lz_onesite` | `Facilities.Staging*` (raw staging tables) |
| Raw source table pattern | `lz_onesite.OneSiteProperty_dbo_<SourceTable>` | `Facilities.StagingWorkOrder`, `Facilities.Staging<Table>` |
| Staging source pattern | N/A (handled in temp tables) | `Facilities.StagingSource<Table>` |
| Staging dimension pattern | N/A (handled in temp tables) | `Facilities.StagingDim<Table>` |
| Final dimension table | `cl_unified_pms.<Table>` | `dbo.Dim<Table>` |
| Final fact table | `cl_unified_pms.<Table>` | `dbo.Fact<Table>` |

---

## 2. Table-Level Mapping

| GCP Table | RA Table | Notes |
|-----------|----------|-------|
| `cl_unified_pms.WorkOrder` | `dbo.DimWorkOrder` | |
| `cl_unified_pms.Invoice` | `dbo.DimInvoice` | |
| `cl_unified_pms.Employee` | `dbo.DimEmployee` | |
| `cl_unified_pms.CodeLookup` | `dbo.DimCodeLookup` | Note capitalization: GCP `CodeLookup` vs RA `DimCodeLookUp` |
| `cl_unified_pms.Property` | `dbo.DimProperty` | |
| `cl_unified_pms.Unit` | `dbo.DimUnit` | |
| `cl_unified_pms.Building` | `dbo.DimBuilding` | |
| `cl_unified_pms.FloorPlan` | `dbo.DimFloorPlan` | |
| `cl_unified_pms.Lease` | `dbo.FactLease` + `dbo.DimLeaseAttributes` | GCP single table; RA splits fact/dim |
| `cl_unified_pms.ServiceRequest` | `dbo.DimServiceRequest` | |
| `cl_unified_pms.StandardCalendar` | `dbo.DimStandardCalendar` | |
| `cl_unified_pms.PropertyManagementCompany` | `dbo.DimPMC` (assumed) | |
| `cl_unified_pms.PropertyType` | N/A (lookup/ref table) | |

### Landing Zone to Staging Source Mapping

| GCP Landing Zone Table | RA Staging Table |
|----------------------|------------------|
| `lz_onesite.OneSiteProperty_dbo_WorkOrder` | `Facilities.StagingWorkOrder` → `Facilities.StagingSourceWorkOrder` |
| `lz_onesite.OneSiteProperty_dbo_WorkOrderOnHold` | `Facilities.StagingWOOnHold` → `Facilities.StagingSourceWorkOrderOnHold` |
| `lz_onesite.OneSiteProperty_dbo_ServiceRequestHistory` | `Facilities.SourceServiceRequestHistory` |
| `lz_onesite.OneSiteProperty_dbo_WorkGroup` | `Facilities.SourceWorkGroup` |
| `lz_onesite.OneSiteProperty_dbo_Employee` | `dbo.DimEmployee` (via staging) |
| `lz_onesite.OneSiteProperty_dbo_Unit` | `dbo.DimUnit` (via staging) |
| `lz_onesite.OneSiteProperty_dbo_WOPriority` | `Facilities.StagingSourceWOPriority` |
| `lz_onesite.OneSiteProperty_dbo_SRStatus` | `Facilities.StagingSourceSRStatus` |
| `lz_onesite.OneSiteProperty_dbo_ProblemSpec` | `Facilities.StagingSourceProblemSpec` |
| `lz_onesite.OneSiteProperty_dbo_ProblemItem` | `Facilities.StagingSourceProblemItem` |
| `lz_onesite.OneSiteProperty_dbo_ProblemCategory` | `Facilities.StagingSourceProblemCategory` |
| `lz_onesite.OneSiteProperty_dbo_ProblemCategoryType` | `Facilities.StagingSourceProblemCategoryType` |
| `lz_onesite.OneSiteProperty_dbo_IssueLocations` | `Facilities.StagingSourceIssueLocations` |
| `lz_onesite.OneSiteProperty_dbo_SiteEmployeeTable` | `Facilities.SourceSiteEmployeeTable` |

---

## 3. Stored Procedure Naming

| GCP Procedure | RA Procedure(s) | Purpose |
|--------------|-----------------|---------|
| `cl_unified_pms.sp_WorkOrder_upsert` | `Facilities.asp_MergeWorkOrderIntoStaging` | Main ETL for WorkOrder |
| N/A | `Facilities.asp_MergeSourceWorkOrderIntoSource` | RA source staging (no GCP equivalent — GCP reads lz directly) |
| N/A | `Facilities.asp_MergeSourceWorkOrderOnHoldIntoSource` | RA on-hold source staging |
| `cl_unified_pms.sp_Property_upsert` | (equivalent RA proc) | Main ETL for Property |
| `cl_unified_pms.sp_Unit_upsert` | (equivalent RA proc) | Main ETL for Unit |
| `cl_unified_pms.sp_Invoice_upsert` | (equivalent RA proc) | Main ETL for Invoice |
| `cl_unified_pms.sp_Employee_upsert` | (equivalent RA proc) | Main ETL for Employee |

### Utility routines

| GCP Routine | RA Routine | Purpose |
|------------|------------|---------|
| `cl_unified_pms.sp_GetDateBoundary` | `dbo.udfGetPropertyList` (partially) | Get incremental date boundaries |
| `cl_unified_pms.sp_LogRunStatus` | `Admin.asp_ETLProcessLog` | ETL run logging |
| `cl_unified_pms.tf_CheckLastRunStatus` | `Admin.AggregateControl` table check | Prevent concurrent runs |
| `cl_unified_pms.udf_GetDeletedInd` | Inline `CASE WHEN CDSExtractType='D'` | Deleted indicator derivation |
| `cl_unified_pms.udf_GetPropertyManagementSourceKey` | Inline or hardcoded | PMS source key lookup |
| `INITCAP()` (built-in) | `[dbo].[InitCap]()` (UDF) | Title case conversion |

---

## 4. Column Prefix and Suffix Conventions

### Identifier prefixes

| GCP Prefix | RA Prefix | Meaning | Examples |
|-----------|----------|---------|----------|
| `Rs` | `osl_` | Raw source / OneSite identifier | `RsPMCID` ↔ `osl_PMCID` |
| `Rs` | `osl_CDS` | CDS-prefixed variant (rare) | `RsPMCID` ↔ `osl_CDSPMCID` |
| (none) | (none) | Business-level columns use no prefix | `Status` ↔ `Status` |

### Data type suffixes

| GCP Suffix | RA Suffix | Data Type | Examples |
|-----------|----------|-----------|----------|
| `Ind` | `Bit` or `Flag` | Boolean | `MakeReadyInd` ↔ `MakeReadyFlag` |
| `Dt` / `Dtm` | `Date` | Datetime | `ActualCompletedDt` ↔ `ActualCompletedDate` |
| `Cnt` | `Count` | Integer count | `ExcludeWeekEndDaysCnt` ↔ `ExcludeWeekEndDaysCount` |
| `Nm` | `Name` | String name | `EmployeeNm` ↔ `EmployeeName` |
| `Dsc` | `Description` | String description | `UnitDsc` ↔ `UnitDescription` |
| `Cd` | `Code` | Code/enum string | `StatusCd` ↔ `StatusCode` |
| `Nb` | `Number` | Numeric identifier (not surrogate) | `RsEmployeeNb` ↔ `osl_EmployeeNumber` |
| `Adr` | `Address` | Address string | `EmailAdr` ↔ `EmailAddress` |
| `Amt` | `Amount` | Monetary amount | `DepositAmt` ↔ `DepositAmount` |
| `Pct` | `Percentage` | Percentage value | `CensusPct` ↔ `CensusPercentage` |
| `Txt` | `Text` | Free text | `StreetNumberTxt` ↔ (varies) |

### Boolean representation

| GCP | RA | Meaning |
|-----|-----|---------|
| `TRUE` / `FALSE` (BOOL) | `1` / `0` (BIT) | Boolean value |
| `TRUE` / `FALSE` (BOOL) | `'Y'` / `'N'` (CHAR) | Soft delete / row current flags |

### ETL metadata columns

| GCP Column | RA Column | Purpose |
|-----------|----------|---------|
| `ETLModifiedDtm` | `RecordModifiedDate` | Last ETL update timestamp |
| `DeletedInd` | `IsDeleted` | Soft delete indicator |
| `RsLogTime` | `CDSSourceLogTime` (in staging) | Source extraction timestamp |
| N/A | `RowStartDate` / `RowEndDate` / `RowIsCurrent` / `IsLastRow` | SCD Type 2 columns (RA only) |
| N/A | `CDSExtractDate` / `CDSExtractType` / `CDSLogSequence` | CDS extraction metadata (in staging) |

---

## 5. SQL Dialect Translation

### Date/Time functions

| Operation | BigQuery | SQL Server |
|-----------|----------|------------|
| Date diff (days) | `DATE_DIFF(end_date, start_date, DAY)` | `DATEDIFF(DAY, start_date, end_date)` |
| Timestamp diff (minutes) | `TIMESTAMP_DIFF(end_ts, start_ts, MINUTE)` | `DATEDIFF_BIG(MINUTE, start_ts, end_ts)` |
| Current timestamp | `CURRENT_TIMESTAMP` | `GETDATE()` |
| Cast to date | `CAST(x AS DATE)` or `DATE(x)` | `CAST(x AS DATE)` |
| Cast to datetime | `CAST(x AS DATETIME)` | `CAST(x AS DATETIME)` |
| Date from parts | `DATE(year, month, day)` | `DATEFROMPARTS(year, month, day)` |
| Extract part | `EXTRACT(DAYOFWEEK FROM d)` | `DATEPART(dw, d)` |

**CRITICAL: Argument order differs!**
- BigQuery: `DATE_DIFF(end, start, part)` — end comes FIRST
- SQL Server: `DATEDIFF(part, start, end)` — part comes FIRST, then start, then end

### Null handling

| Operation | BigQuery | SQL Server |
|-----------|----------|------------|
| Null replacement | `IFNULL(x, y)` or `COALESCE(x, y)` | `ISNULL(x, y)` or `COALESCE(x, y)` |
| Null-safe equals | `x IS NOT DISTINCT FROM y` | N/A (use `ISNULL(x,'') = ISNULL(y,'')`) |
| Safe cast | `SAFE_CAST(x AS type)` | `TRY_CAST(x AS type)` (2012+) |

### String functions

| Operation | BigQuery | SQL Server |
|-----------|----------|------------|
| Title case | `INITCAP(x)` | `[dbo].[InitCap](x)` (custom UDF) |
| Concat | `CONCAT(a, b)` | `CONCAT(a, b)` or `a + b` |
| Trim | `TRIM(x)` | `LTRIM(RTRIM(x))` or `TRIM(x)` (2017+) |
| Regex match | `REGEXP_CONTAINS(x, r'pattern')` | N/A (use `LIKE` or CLR) |
| Cast to string | `CAST(x AS STRING)` | `CAST(x AS VARCHAR(n))` |

### Deduplication

| BigQuery | SQL Server |
|----------|------------|
| `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...) = 1` | `; WITH CTE AS (SELECT ..., ROW_NUMBER() OVER (...) AS rn) SELECT * FROM CTE WHERE rn = 1` |

### DDL / Temp tables

| BigQuery | SQL Server |
|----------|------------|
| `CREATE OR REPLACE TEMP TABLE t AS SELECT ...` | `SELECT ... INTO #t FROM ...` or `INSERT INTO Staging... SELECT ...` |
| Temp tables auto-drop at session end | Explicit `DROP TABLE #t` or `IF OBJECT_ID('tempdb..#t') IS NOT NULL DROP TABLE #t` |

### Error handling

| BigQuery | SQL Server |
|----------|------------|
| `BEGIN ... EXCEPTION WHEN ERROR THEN ... END` | `BEGIN TRY ... END TRY BEGIN CATCH ... END CATCH` |
| `@@error.message` | `ERROR_MESSAGE()`, `ERROR_NUMBER()`, `ERROR_SEVERITY()`, `ERROR_STATE()` |
| `RAISE USING MESSAGE = ...` | `RAISERROR(@msg, @sev, @state)` |

### Merge statement

| BigQuery | SQL Server |
|----------|------------|
| `MERGE table AS tgt USING src ON ... WHEN MATCHED THEN UPDATE SET ... WHEN NOT MATCHED THEN INSERT ...` | Same syntax (supported since SQL Server 2008) |
| No `WHEN NOT MATCHED BY SOURCE` | Supports `WHEN NOT MATCHED BY SOURCE THEN DELETE/UPDATE` |

---

## 6. Key Join Pattern Mapping

### Employee join

```sql
-- GCP
LEFT JOIN cl_unified_pms.Employee E
  ON E.RsEmployeeNb = wo.woactualcompleteby
  AND wo.cdspmcid = COALESCE(E.RsPMCID, wo.cdspmcid)
  AND E.DeletedInd = FALSE
  -- CAUTION: some procs add E.UserDisableInd = 0 (not in RA)

-- RA
LEFT JOIN #Employee EAC
  ON EAC.osl_EmployeeNumber = CAST(WO.actualCompletedBy AS VARCHAR(10))
  AND WO.CDSPMCID = ISNULL(EAC.osl_CDSPMCID, WO.CDSPMCID)
  AND EAC.IsDeleted <> 'Y'
```

### CodeLookup join

```sql
-- GCP
LEFT JOIN cl_unified_pms.CodeLookup CL
  ON CL.RsPMCID = wo.cdspmcid
  AND CL.RsPropertyID = wo.cdspropertyid
  AND CL.CodeLookupClassNm = 'SRCurrentStatus'
  AND CL.CodeLookupCodeNm = wo.StatusCode
  AND CL.DeletedInd = FALSE

-- RA
LEFT JOIN dbo.DimCodeLookup CL
  ON WO.CDSPMCID = CL.osl_PMCID
  AND WO.CDSPropertyID = CL.osl_PropertyID
  AND CL.CodeLUClassName = 'SRCurrentStatus'
  AND WO.StatusCode = CL.CodeLUCodeName
  AND CL.IsDeleted <> 'Y'
```

### Property join

```sql
-- GCP
INNER JOIN cl_unified_pms.Property P
  ON P.RsPMCID = wo.cdspmcid
  AND P.RsPropertyID = wo.cdspropertyid

-- RA
INNER JOIN dbo.DimProperty P
  ON l.osl_PropertyID = P.osl_PropertyID
  AND l.osl_PMCID = P.osl_PMCID
  AND P.PropertySourceCode = 1     -- OneSite only (RA-specific filter)
  AND P.IsDeleted <> 'Y'
```

---

## 7. Usage Notes for the Agent

1. **Always use this mapping when generating cross-platform diagnostic queries** — never assume column names are the same.
2. **When comparing join conditions**, translate both sides to a canonical form using this mapping before diffing.
3. **Watch for `osl_CDSPMCID` vs `osl_PMCID`** — RA uses both interchangeably in different contexts. They refer to the same value.
4. **RA has SCD Type 2 columns** (`RowStartDate`, `RowEndDate`, `RowIsCurrent`, `IsLastRow`) that GCP does not have. Ignore these in comparisons.
5. **RA has surrogate keys** (`PropertyKey`, `UnitKey`, `BuildingKey`) that GCP also has but may derive differently. These are usually not compared in parity tests.
6. **GCP `DeletedInd` is BOOL**; RA `IsDeleted` is CHAR(1) 'Y'/'N'. Semantically equivalent but the agent must use the correct literal for each platform.

---

*This document is a living reference. Update as new tables are investigated and new naming patterns are discovered.*
