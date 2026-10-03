'use strict';

/**
 * Equipment / instrument qualification, calibration and maintenance register.
 *
 * ===================================================================
 * STATUS: OUT OF SCOPE FOR A PHARMACOVIGILANCE INSTANCE - RETAINED ONLY
 *         FOR BACKWARD COMPATIBILITY. READ BEFORE MODIFYING.
 * ===================================================================
 *
 * This module is inherited from the LeebertyGXP product this workbench was
 * built from. It implements EU GMP Chapter 3, Annex 15 qualification and
 * 21 CFR 211.160(b)(4) instrument calibration - all of which govern a
 * manufacturing site, and none of which govern a drug-safety department.
 * A marketing-authorisation holder running a pharmacovigilance system has no
 * instruments to calibrate. The regulatory basis cited below is real, but it
 * is real for a *different product*.
 *
 * It is therefore deliberately NOT wired into the pharmacovigilance user
 * experience: there is no navigation entry, no dashboard panel, and no task
 * rule that surfaces an instrument to a PV officer. A PV professional must
 * never be told that a pipette is overdue.
 *
 * What remains live, and why:
 *   - the `equipment` table and `/api/equipment`, because existing instances
 *     and the test suite treat the register as a general "recurring
 *     obligation" fixture, and dropping a table from a database that holds an
 *     audit chain is a migration with real consequences;
 *   - the monitor's calibration scan, which is a no-op on any instance with no
 *     equipment rows - which is every real PV instance.
 *
 * A new recurring obligation for PV should be added as its own module with its
 * own regulatory basis, not by reviving this one.
 *
 * Original regulatory basis (applies to the GxP product this came from)
 * ---------------------------------------------------------------------
 *  - EU GMP Chapter 3 (premises and equipment) §3.3-3.6: equipment must be
 *    suitable for its intended use, installed/qualified for that use, easy to
 *    clean and maintain, and measuring instruments must be calibrated at
 *    defined intervals.
 *  - EU GMP Annex 15 §3 (qualification): DQ -> IQ -> OQ -> PQ, and
 *    re-qualification after changes, moves or major repairs. `qualificationComplete`
 *    below is the IQ+OQ+PQ half of that lifecycle; the DQ half lives in document
 *    control (the qualification/validation package).
 *  - 21 CFR Part 211.67(a)-(c): equipment shall be cleaned, maintained and
 *    sanitised at appropriate intervals, with written procedures and records ->
 *    `recordMaintenance`, `last_maintenance_date` / `next_maintenance_date`.
 *  - 21 CFR Part 211.160(b)(4): laboratory instruments shall be calibrated at
 *    suitable intervals in accordance with an established written programme ->
 *    the calibration interval and next-due date are first-class columns here,
 *    never free text.
 *  - GLP 21 CFR Part 58.63(a)/(b): equipment shall be adequately inspected,
 *    cleaned and maintained; measuring instruments and equipment shall be
 *    tested, calibrated or standardised at intervals and the results documented.
 *  - 21 CFR Part 11.10(e) / EU GMP Annex 11 §9: every change to a GxP record
 *    carries a stated reason and lands in the append-only audit trail.
 *
 * Design notes
 * ------------
 * 1. Nothing in this module ever deletes a row. An instrument leaves service
 *    through a *status transition* (`out_of_service`, `under_maintenance`,
 *    `quarantined`, `retired`), so the register stays reconstructible from the
 *    audit trail alone (ALCOA+ "Enduring"/"Available").
 * 2. Calibration and maintenance *events* are recorded as audit-trail entries
 *    (severity `critical` when the outcome matters), while the *scheduling*
 *    state is denormalised onto the equipment row (`last_*`/`next_*` dates).
 *    The register is therefore always answering "when is this instrument due?"
 *    without a join, and the full event history is still immutable.
 * 3. An instrument that requires calibration but has no scheduled due date is
 *    reported as `valid` with `nextCalibrationDate === null`: only a date that
 *    has actually passed makes equipment overdue (this keeps `calibrationStatus`
 *    consistent with SQL that reports on `next_calibration_date`, and keeps a
 *    freshly registered asset out of the deviation queue until its first
 *    calibration plan is entered).
 */

const config = require('../config');
const db = require('../core/db');
const audit = require('../core/audit');

function nowIso() { return new Date().toISOString(); }
function today() { return new Date().toISOString().slice(0, 10); }

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

// ---------------------------------------------------------------- tables ----

/** Lifecycle states of an instrument (`equipment.status`). */
const STATUSES = ['in_service', 'out_of_service', 'under_maintenance', 'quarantined', 'retired'];

/** Qualification states of an instrument (`equipment.qualification_status`). */
const QUALIFICATION_STATUSES = [
  'not_qualified', 'in_progress', 'qualified', 'requalification_due', 'disqualified',
];

/** Risk classification (`equipment.criticality`). */
const CRITICALITY_LEVELS = ['low', 'medium', 'high', 'critical'];

/**
 * "GxP-critical" equipment: loss or mis-calibration of these directly affects
 * product quality or the integrity of study data. Used by `metrics()` and
 * `calibrationDueReport()` to separate "the register is tidy" from "we have a
 * compliance exposure".
 */
const GXP_CRITICAL_LEVELS = ['critical', 'high'];

/** Calibration / maintenance outcomes that keep an instrument in service. */
const PASS_RESULTS = ['pass', 'passed', '合格', 'compliant'];

/** Computed calibration states returned by `getEquipment` / `listEquipment`. */
const CALIBRATION_STATUSES = ['valid', 'due_soon', 'overdue', 'not_required'];

/**
 * Fallback cycle applied when a calibration/maintenance event is recorded but
 * neither an explicit next-due date nor an interval is known: a calibration
 * without a successor schedule is itself a finding, so the register always
 * schedules the next one and states in the audit entry which interval it used.
 */
const DEFAULT_CALIBRATION_INTERVAL_DAYS = 365;
const DEFAULT_MAINTENANCE_INTERVAL_DAYS = 365;

/** Columns a caller may write through the API (the whitelist). */
const ALLOWED_UPDATE_COLUMNS = [
  'asset_no', 'name', 'name_en', 'model', 'manufacturer', 'serial_no', 'location',
  'department', 'gxp_areas', 'qualification_status', 'iq_date', 'oq_date', 'pq_date',
  'calibration_required', 'calibration_interval_days', 'last_calibration_date',
  'next_calibration_date', 'maintenance_interval_days', 'last_maintenance_date',
  'next_maintenance_date', 'status', 'criticality', 'csv_status', 'csv_ref', 'notes',
];

/** Date-only columns: stored as YYYY-MM-DD, compared as strings. */
const DATE_COLUMNS = [
  'iq_date', 'oq_date', 'pq_date', 'last_calibration_date', 'next_calibration_date',
  'last_maintenance_date', 'next_maintenance_date',
];

const EQUIPMENT_COLUMNS =
  'id, asset_no, name, name_en, model, manufacturer, serial_no, location, department, gxp_areas, ' +
  'qualification_status, iq_date, oq_date, pq_date, calibration_required, calibration_interval_days, ' +
  'last_calibration_date, next_calibration_date, maintenance_interval_days, last_maintenance_date, ' +
  'next_maintenance_date, status, criticality, csv_status, csv_ref, notes, created_at, updated_at';

// ----------------------------------------------------------------- utils ----

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

/** `input.camelCase` wins, `input.snake_case` is accepted as an alias. */
function field(input, camelKey, snakeKey) {
  if (!input) return undefined;
  if (input[camelKey] !== undefined) return input[camelKey];
  if (input[snakeKey] !== undefined) return input[snakeKey];
  return undefined;
}

function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Normalise enum-ish text so filters and metrics stay comparable. */
function enumText(value) {
  const text = textOrNull(value);
  return text === null ? null : text.toLowerCase().replace(/\s+/g, '_');
}

function boolToInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    return ['0', 'false', 'no', 'off', 'n'].includes(value.trim().toLowerCase()) ? 0 : 1;
  }
  return value ? 1 : 0;
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A date-only value (YYYY-MM-DD); accepts full ISO 8601 strings too. */
function dateOrNull(value, name) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const head = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (head) return head[1];
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw httpError(400, 'INVALID_DATE', `${name || 'value'} must be an ISO 8601 date (YYYY-MM-DD), got "${text}"`);
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function dateOrToday(value, name) { return dateOrNull(value, name) || today(); }

function intervalOrNull(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw httpError(400, 'INVALID_INTERVAL', `${name || 'interval'} must be a positive number of days`);
  }
  return Math.round(n);
}

function normaliseGxpAreas(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    const areas = value.map((v) => String(v).trim()).filter(Boolean);
    return areas.length ? JSON.stringify(areas) : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const parsed = parseJson(text, null);
    if (Array.isArray(parsed)) {
      const areas = parsed.map((v) => String(v).trim()).filter(Boolean);
      return areas.length ? JSON.stringify(areas) : null;
    }
    return text ? JSON.stringify([text]) : null;
  }
  throw httpError(400, 'INVALID_GXP_AREAS', 'gxpAreas must be an array of GxP area codes');
}

function addDays(dateStr, days) {
  const parsed = Date.parse(String(dateStr));
  const n = numOrNull(days);
  if (!Number.isFinite(parsed) || n === null) return null;
  return new Date(parsed + n * 86400000).toISOString().slice(0, 10);
}

/** Whole days until a date-only value; negative once the date has passed. */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const parsed = Date.parse(String(dateStr));
  if (!Number.isFinite(parsed)) return null;
  return Math.ceil((parsed - Date.now()) / 86400000);
}

function computeNextDate(lastDate, intervalDays) {
  if (!lastDate) return null;
  const n = numOrNull(intervalDays);
  if (n === null || n <= 0) return null;
  return addDays(lastDate, n);
}

function calibrationWarningDays() {
  const n = Number(config.reminder.calibrationWarningDays);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Maintenance has no dedicated warning window; the calibration window is used. */
function maintenanceWarningDays() { return calibrationWarningDays(); }

function isPassResult(result) {
  const text = textOrNull(result);
  return text !== null && PASS_RESULTS.includes(text.toLowerCase());
}

function isGxpCritical(row) {
  return row != null && GXP_CRITICAL_LEVELS.includes(String(row.criticality || '').toLowerCase());
}

/**
 * Scheduling state for one due date.
 * `overdue` requires a date that has actually passed; `valid` also covers
 * "required but not yet scheduled" (see the file header, design note 3).
 */
function scheduleStatus(nextDate, required, warnDays) {
  if (!required) return 'not_required';
  if (!nextDate) return 'valid';
  if (String(nextDate).slice(0, 10) < today()) return 'overdue';
  const days = daysUntil(nextDate);
  if (days !== null && days <= warnDays) return 'due_soon';
  return 'valid';
}

function deriveQualificationStatus(iq, oq, pq) {
  const present = [iq, oq, pq].filter(Boolean).length;
  if (present === 3) return 'qualified';
  if (present > 0) return 'in_progress';
  return null;
}

function normaliseQualificationStatus(value) {
  const text = enumText(value);
  if (text === null) return null;
  const synonyms = {
    complete: 'qualified', completed: 'qualified', compliant: 'qualified', qualified_: 'qualified',
    partial: 'in_progress', 'in-progress': 'in_progress', pending: 'not_qualified', none: 'not_qualified',
    requalification: 'requalification_due', expired: 'requalification_due', rejected: 'disqualified',
  };
  return synonyms[text] || text;
}

function recordKeyFor(id) { return `equipment:${id}`; }

/**
 * Next record version for the audit trail. Equipment has no version column, so
 * the version is derived from the number of entries already written under the
 * same record key - the history stays contiguous for `verifyRecordHistory`.
 */
function nextRecordVersion(recordKey) {
  return db.get('SELECT COUNT(*) AS n FROM audit_trail WHERE record_key = ?', [recordKey]).n + 1;
}

/** Accept an id, an asset number, or a `{signatureId}`-wrapped signature id. */
function resolveSignatureId(explicit, payload) {
  let value = explicit;
  if (value !== null && typeof value === 'object') value = value.signatureId;
  if (value === undefined || value === null || value === '') {
    value = payload ? payload.signatureId : null;
  }
  const n = numOrNull(value);
  return n === null ? null : Math.trunc(n);
}

function applyPatch(table, id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => patch[c]), id]);
}

function toSnake(s) {
  return String(s).replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/** Look up an instrument by numeric id first, then by asset number. */
function resolveRow(idOrAssetNo) {
  if (idOrAssetNo === undefined || idOrAssetNo === null || idOrAssetNo === '') return null;
  const key = String(idOrAssetNo).trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) {
    const byId = db.get(`SELECT ${EQUIPMENT_COLUMNS} FROM equipment WHERE id = ?`, [Number(key)]);
    if (byId) return byId;
  }
  return db.get(`SELECT ${EQUIPMENT_COLUMNS} FROM equipment WHERE asset_no = ? COLLATE NOCASE`, [key]) || null;
}

/** camelCase projection + the computed compliance fields. */
function mapEquipment(row) {
  if (!row) return null;
  const calibrationRequired = Number(row.calibration_required) === 1;
  const maintenanceScheduled = Boolean(row.maintenance_interval_days) || Boolean(row.next_maintenance_date);
  return {
    id: row.id,
    recordKey: recordKeyFor(row.id),
    assetNo: row.asset_no,
    name: row.name,
    nameEn: row.name_en,
    model: row.model,
    manufacturer: row.manufacturer,
    serialNo: row.serial_no,
    location: row.location,
    department: row.department,
    gxpAreas: parseJson(row.gxp_areas, []),
    qualificationStatus: row.qualification_status,
    iqDate: row.iq_date,
    oqDate: row.oq_date,
    pqDate: row.pq_date,
    qualificationComplete: Boolean(row.iq_date && row.oq_date && row.pq_date),
    calibrationRequired,
    calibrationIntervalDays: row.calibration_interval_days,
    lastCalibrationDate: row.last_calibration_date,
    nextCalibrationDate: row.next_calibration_date,
    calibrationStatus: scheduleStatus(row.next_calibration_date, calibrationRequired, calibrationWarningDays()),
    daysToCalibration: daysUntil(row.next_calibration_date),
    maintenanceIntervalDays: row.maintenance_interval_days,
    lastMaintenanceDate: row.last_maintenance_date,
    nextMaintenanceDate: row.next_maintenance_date,
    maintenanceStatus: scheduleStatus(row.next_maintenance_date, maintenanceScheduled, maintenanceWarningDays()),
    daysToMaintenance: daysUntil(row.next_maintenance_date),
    status: row.status,
    criticality: row.criticality,
    gxpCritical: isGxpCritical(row),
    csvStatus: row.csv_status,
    csvRef: row.csv_ref,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Compact projection used by the due report. */
function mapDueRow(row) {
  return {
    id: row.id,
    assetNo: row.asset_no,
    name: row.name,
    nameEn: row.name_en,
    location: row.location,
    department: row.department,
    criticality: row.criticality,
    gxpAreas: parseJson(row.gxp_areas, []),
    status: row.status,
    lastCalibrationDate: row.last_calibration_date,
    nextCalibrationDate: row.next_calibration_date,
    calibrationIntervalDays: row.calibration_interval_days,
    daysToCalibration: daysUntil(row.next_calibration_date),
    calibrationStatus: scheduleStatus(row.next_calibration_date, true, calibrationWarningDays()),
  };
}

// ---------------------------------------------------------------- create ----

/**
 * Register a new instrument.
 *
 * `assetNo` and `name` are mandatory and `assetNo` is unique site-wide (it is
 * the identifier every logbook, certificate and deviation will quote).
 * `nextCalibrationDate` / `nextMaintenanceDate` are derived from the last
 * performed date plus the interval whenever they are not supplied explicitly.
 */
function createEquipment(input, actor, ctx) {
  const src = input || {};
  const assetNo = textOrNull(field(src, 'assetNo', 'asset_no'));
  const name = textOrNull(field(src, 'name', 'name'));
  if (!assetNo) {
    throw httpError(400, 'ASSET_NO_REQUIRED', 'An asset/instrument number is required (unique identifier, ALCOA+ "Attributable")');
  }
  if (!name) throw httpError(400, 'NAME_REQUIRED', 'An equipment name is required (at least one character)');

  const calibrationRequired = boolToInt(field(src, 'calibrationRequired', 'calibration_required'), 1);
  const calibrationInterval = intervalOrNull(field(src, 'calibrationIntervalDays', 'calibration_interval_days'), 'calibrationIntervalDays');
  const maintenanceInterval = intervalOrNull(field(src, 'maintenanceIntervalDays', 'maintenance_interval_days'), 'maintenanceIntervalDays');

  const iq = dateOrNull(field(src, 'iqDate', 'iq_date'), 'iqDate');
  const oq = dateOrNull(field(src, 'oqDate', 'oq_date'), 'oqDate');
  const pq = dateOrNull(field(src, 'pqDate', 'pq_date'), 'pqDate');

  const lastCalibration = dateOrNull(field(src, 'lastCalibrationDate', 'last_calibration_date'), 'lastCalibrationDate');
  const statedNextCalibration = dateOrNull(field(src, 'nextCalibrationDate', 'next_calibration_date'), 'nextCalibrationDate');
  const lastMaintenance = dateOrNull(field(src, 'lastMaintenanceDate', 'last_maintenance_date'), 'lastMaintenanceDate');
  const statedNextMaintenance = dateOrNull(field(src, 'nextMaintenanceDate', 'next_maintenance_date'), 'nextMaintenanceDate');

  // --- auto-scheduling (21 CFR 211.160(b)(4), 211.67(c)) --------------------
  const nextCalibration = calibrationRequired
    ? (statedNextCalibration || computeNextDate(lastCalibration, calibrationInterval))
    : null;
  const nextMaintenance = statedNextMaintenance || computeNextDate(lastMaintenance, maintenanceInterval);

  const at = nowIso();
  let id;

  db.transaction(() => {
    if (db.get('SELECT id FROM equipment WHERE asset_no = ? COLLATE NOCASE', [assetNo])) {
      throw httpError(409, 'ASSET_NO_EXISTS', `Equipment asset number "${assetNo}" already exists`);
    }
    db.run(
      'INSERT INTO equipment (asset_no, name, name_en, model, manufacturer, serial_no, location, department, ' +
      'gxp_areas, qualification_status, iq_date, oq_date, pq_date, calibration_required, ' +
      'calibration_interval_days, last_calibration_date, next_calibration_date, maintenance_interval_days, ' +
      'last_maintenance_date, next_maintenance_date, status, criticality, csv_status, csv_ref, notes, ' +
      'created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        assetNo, name, textOrNull(field(src, 'nameEn', 'name_en')),
        textOrNull(field(src, 'model', 'model')), textOrNull(field(src, 'manufacturer', 'manufacturer')),
        textOrNull(field(src, 'serialNo', 'serial_no')), textOrNull(field(src, 'location', 'location')),
        textOrNull(field(src, 'department', 'department')), normaliseGxpAreas(field(src, 'gxpAreas', 'gxp_areas')),
        normaliseQualificationStatus(field(src, 'qualificationStatus', 'qualification_status'))
          || deriveQualificationStatus(iq, oq, pq),
        iq, oq, pq, calibrationRequired, calibrationInterval, lastCalibration, nextCalibration,
        maintenanceInterval, lastMaintenance, nextMaintenance,
        enumText(field(src, 'status', 'status')) || 'in_service',
        enumText(field(src, 'criticality', 'criticality')),
        enumText(field(src, 'csvStatus', 'csv_status')), textOrNull(field(src, 'csvRef', 'csv_ref')),
        textOrNull(field(src, 'notes', 'notes')), at, at,
      ]
    );
    id = db.get('SELECT last_insert_rowid() AS id').id;

    audit.append({
      action: 'create',
      entityType: 'equipment',
      entityId: id,
      recordKey: recordKeyFor(id),
      recordVersion: 1,
      actor,
      reason: textOrNull(field(src, 'reason', 'reason')) || `Equipment ${assetNo} registered in the GxP register`,
      ctx,
      newValue: {
        asset_no: assetNo, name, department: textOrNull(src.department) || null,
        location: textOrNull(src.location) || null,
        criticality: enumText(src.criticality), status: enumText(src.status) || 'in_service',
        qualification_status: normaliseQualificationStatus(src.qualificationStatus) || deriveQualificationStatus(iq, oq, pq),
        calibration_required: calibrationRequired,
        calibration_interval_days: calibrationInterval,
        last_calibration_date: lastCalibration,
        next_calibration_date: nextCalibration,
        maintenance_interval_days: maintenanceInterval,
        last_maintenance_date: lastMaintenance,
        next_maintenance_date: nextMaintenance,
      },
      gxpAreas: parseJson(normaliseGxpAreas(field(src, 'gxpAreas', 'gxp_areas')), []),
      severity: 'info',
    });
  });

  return getEquipment(id);
}

// ---------------------------------------------------------------- update ----

/**
 * Update an instrument.
 *
 * `reason` is mandatory (>= 3 characters): a GxP record change without a stated
 * reason is not reconstructible, which is exactly what 21 CFR Part 11.10(e)
 * forbids. The before/after snapshots are written to the audit trail as a delta.
 *
 * `nextCalibrationDate` / `nextMaintenanceDate` are recomputed whenever the
 * corresponding last-date, interval or "calibration required" flag changes and
 * no explicit next date was supplied.
 */
function updateEquipment(id, patch, actor, ctx, reason) {
  const row = resolveRow(id);
  if (!row) throw httpError(404, 'EQUIPMENT_NOT_FOUND', `No equipment with id/asset number "${id}"`);

  const note = textOrNull(reason);
  if (!note || note.length < 3) {
    throw httpError(400, 'REASON_REQUIRED',
      'Every change to a GxP record requires a stated reason of at least 3 characters (21 CFR Part 11.10(e))');
  }

  const src = patch || {};
  const dbPatch = {};
  for (const [key, value] of Object.entries(src)) {
    const col = toSnake(key);
    if (!ALLOWED_UPDATE_COLUMNS.includes(col)) continue;
    if (value === undefined) continue;

    if (col === 'asset_no' || col === 'name') {
      const text = textOrNull(value);
      if (!text) {
        throw httpError(400, col === 'asset_no' ? 'ASSET_NO_REQUIRED' : 'NAME_REQUIRED', `"${col}" cannot be emptied`);
      }
      if (col === 'asset_no' && text.toLowerCase() !== String(row.asset_no).toLowerCase()
        && db.get('SELECT id FROM equipment WHERE asset_no = ? COLLATE NOCASE', [text])) {
        throw httpError(409, 'ASSET_NO_EXISTS', `Equipment asset number "${text}" already exists`);
      }
      dbPatch[col] = text;
    } else if (DATE_COLUMNS.includes(col)) {
      dbPatch[col] = dateOrNull(value, key);
    } else if (col === 'calibration_required') {
      dbPatch[col] = boolToInt(value, row.calibration_required ? 1 : 0);
    } else if (col === 'calibration_interval_days' || col === 'maintenance_interval_days') {
      dbPatch[col] = intervalOrNull(value, key);
    } else if (col === 'gxp_areas') {
      dbPatch[col] = normaliseGxpAreas(value);
    } else if (col === 'status' || col === 'criticality' || col === 'csv_status' || col === 'qualification_status') {
      dbPatch[col] = col === 'qualification_status' ? normaliseQualificationStatus(value) : enumText(value);
    } else {
      dbPatch[col] = textOrNull(value);
    }
  }
  if (!Object.keys(dbPatch).length) {
    throw httpError(400, 'NOTHING_TO_UPDATE', 'No updatable field was supplied');
  }

  // --- keep the schedule consistent with the performed dates ---------------
  const touchesCalibration = ['last_calibration_date', 'calibration_interval_days', 'calibration_required']
    .some((col) => col in dbPatch);
  if (touchesCalibration && !('next_calibration_date' in dbPatch)) {
    const required = 'calibration_required' in dbPatch
      ? dbPatch.calibration_required === 1
      : Number(row.calibration_required) === 1;
    const recomputed = required
      ? computeNextDate(
        'last_calibration_date' in dbPatch ? dbPatch.last_calibration_date : row.last_calibration_date,
        'calibration_interval_days' in dbPatch ? dbPatch.calibration_interval_days : row.calibration_interval_days)
      : null;
    if (recomputed !== row.next_calibration_date) dbPatch.next_calibration_date = recomputed;
  }

  const touchesMaintenance = ['last_maintenance_date', 'maintenance_interval_days'].some((col) => col in dbPatch);
  if (touchesMaintenance && !('next_maintenance_date' in dbPatch)) {
    const recomputed = computeNextDate(
      'last_maintenance_date' in dbPatch ? dbPatch.last_maintenance_date : row.last_maintenance_date,
      'maintenance_interval_days' in dbPatch ? dbPatch.maintenance_interval_days : row.maintenance_interval_days);
    if (recomputed !== row.next_maintenance_date) dbPatch.next_maintenance_date = recomputed;
  }

  const before = {};
  const after = {};
  for (const col of Object.keys(dbPatch)) {
    before[col] = row[col];
    after[col] = dbPatch[col];
  }
  dbPatch.updated_at = nowIso();

  const recordKey = recordKeyFor(row.id);
  db.transaction(() => {
    applyPatch('equipment', row.id, dbPatch);
    audit.recordChange({
      actor,
      entityType: 'equipment',
      entityId: row.id,
      recordKey,
      recordVersion: nextRecordVersion(recordKey),
      before,
      after,
      reason: note,
      ctx,
      action: 'update',
      gxpAreas: parseJson(row.gxp_areas, []),
    });
  });

  return getEquipment(row.id);
}

// ------------------------------------------------------------------ read ----

/** Fetch one instrument by numeric id or by asset number (null when unknown). */
function getEquipment(idOrAssetNo) {
  return mapEquipment(resolveRow(idOrAssetNo));
}

/**
 * Paged register with the compliance-relevant filters.
 *
 * Ordering answers the operational question first: instruments whose
 * calibration is overdue come first, then everything else by next-due date
 * ascending with unscheduled instruments last.
 */
function listEquipment(filters) {
  const f = filters || {};
  const where = [];
  const params = [];

  if (textOrNull(f.search)) {
    where.push('(asset_no LIKE ? OR name LIKE ? OR model LIKE ? OR serial_no LIKE ? OR manufacturer LIKE ?)');
    const like = `%${textOrNull(f.search)}%`;
    params.push(like, like, like, like, like);
  }
  if (textOrNull(f.status)) { where.push('status = ?'); params.push(enumText(f.status)); }
  if (textOrNull(f.department)) { where.push('department = ?'); params.push(textOrNull(f.department)); }
  if (textOrNull(f.location)) { where.push('location = ?'); params.push(textOrNull(f.location)); }
  if (textOrNull(f.gxpArea)) { where.push('gxp_areas LIKE ?'); params.push(`%"${textOrNull(f.gxpArea)}"%`); }
  if (textOrNull(f.criticality)) { where.push('criticality = ?'); params.push(enumText(f.criticality)); }
  if (textOrNull(f.qualificationStatus)) {
    where.push('qualification_status = ?');
    params.push(normaliseQualificationStatus(f.qualificationStatus));
  }

  const warnDays = calibrationWarningDays();
  const horizon = new Date(Date.now() + warnDays * 86400000).toISOString().slice(0, 10);
  const calibrationStatus = textOrNull(f.calibrationStatus);
  if (calibrationStatus) {
    switch (enumText(calibrationStatus)) {
      case 'overdue':
        where.push("calibration_required = 1 AND next_calibration_date IS NOT NULL AND next_calibration_date < date('now')");
        break;
      case 'due_soon':
        where.push("calibration_required = 1 AND next_calibration_date IS NOT NULL " +
          "AND next_calibration_date >= date('now') AND next_calibration_date <= ?");
        params.push(horizon);
        break;
      case 'valid':
        where.push('calibration_required = 1 AND (next_calibration_date IS NULL OR next_calibration_date > ?)');
        params.push(horizon);
        break;
      case 'not_required':
        where.push('calibration_required = 0');
        break;
      default:
        throw httpError(400, 'INVALID_CALIBRATION_STATUS', `calibrationStatus must be one of: ${CALIBRATION_STATUSES.join(', ')}`);
    }
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(f.limit) || 100, 500);
  const offset = Number(f.offset) || 0;
  const total = db.get(`SELECT COUNT(*) AS n FROM equipment ${clause}`, params).n;
  const rows = db.all(
    `SELECT ${EQUIPMENT_COLUMNS} FROM equipment ${clause} ORDER BY
       CASE WHEN calibration_required = 1 AND next_calibration_date IS NOT NULL
                 AND next_calibration_date < date('now') THEN 0 ELSE 1 END,
       next_calibration_date IS NULL,
       next_calibration_date ASC,
       id ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { total, limit, offset, rows: rows.map(mapEquipment) };
}

// ------------------------------------------------------- calibration event --

/**
 * Record a calibration event (21 CFR 211.160(b)(4), GLP 58.63(b)).
 *
 * Sets `last_calibration_date`/`next_calibration_date`, forces
 * `calibration_required = 1` (an instrument that has just been calibrated is by
 * definition in a calibration programme), and writes a **critical** audit entry
 * holding the old vs new dates, the certificate reference and the outcome.
 *
 * A stated non-pass outcome takes the instrument out of service. A pass does
 * *not* silently return it to service: release back into use is a separate,
 * reasoned decision (`updateEquipment` with a reason).
 *
 * @param {number|string} id            equipment id or asset number
 * @param {object} [payload]            {performedAt, performedBy, result, certificateNo, notes, nextDueDate, intervalDays, signatureId}
 * @param {object} [actor]              authenticated user
 * @param {object} [ctx]                request context {ip, sessionId, userAgent}
 * @param {number} [signatureId]        optional e-signature reference threaded into the audit entry
 */
function recordCalibration(id, payload, actor, ctx, signatureId) {
  const row = resolveRow(id);
  if (!row) throw httpError(404, 'EQUIPMENT_NOT_FOUND', `No equipment with id/asset number "${id}"`);
  const p = payload || {};
  const sigId = resolveSignatureId(signatureId, p);

  const performedAt = dateOrToday(field(p, 'performedAt', 'performed_at'), 'performedAt');
  const statedInterval = intervalOrNull(field(p, 'intervalDays', 'interval_days'), 'intervalDays');
  let interval = statedInterval !== null ? statedInterval : numOrNull(row.calibration_interval_days);
  const statedNext = dateOrNull(field(p, 'nextDueDate', 'next_due_date'), 'nextDueDate');
  const nextDue = statedNext || addDays(performedAt, interval !== null ? interval : DEFAULT_CALIBRATION_INTERVAL_DAYS);
  if (interval === null && !statedNext) interval = DEFAULT_CALIBRATION_INTERVAL_DAYS;

  const resultText = textOrNull(field(p, 'result', 'result'));
  const passed = resultText === null ? true : isPassResult(resultText);
  const certificateNo = textOrNull(field(p, 'certificateNo', 'certificate_no'));
  const performedBy = textOrNull(field(p, 'performedBy', 'performed_by'));
  const notes = textOrNull(field(p, 'notes', 'notes'));

  const dbPatch = {
    calibration_required: 1,
    last_calibration_date: performedAt,
    next_calibration_date: nextDue,
    calibration_interval_days: interval,
    updated_at: nowIso(),
  };
  if (!passed) dbPatch.status = 'out_of_service';

  const recordKey = recordKeyFor(row.id);
  const certificateRef = certificateNo || textOrNull(field(p, 'certificateRef', 'certificate_ref'));
  const reason = `Calibration ${resultText ? resultText : 'recorded'} for ${row.asset_no} on ${performedAt}` +
    ` (next due ${nextDue || 'not scheduled'})${certificateRef ? `, certificate ${certificateRef}` : ''}` +
    (passed ? '' : ' - instrument set out of service');

  db.transaction(() => {
    applyPatch('equipment', row.id, dbPatch);
    audit.append({
      action: 'calibration',
      entityType: 'equipment',
      entityId: row.id,
      recordKey,
      recordVersion: nextRecordVersion(recordKey),
      actor,
      reason,
      ctx,
      signatureId: sigId,
      oldValue: {
        last_calibration_date: row.last_calibration_date,
        next_calibration_date: row.next_calibration_date,
        calibration_interval_days: row.calibration_interval_days,
        calibration_required: row.calibration_required,
        status: row.status,
      },
      newValue: {
        last_calibration_date: performedAt,
        next_calibration_date: nextDue,
        calibration_interval_days: interval,
        calibration_required: 1,
        certificate_no: certificateRef,
        result: resultText,
        performed_by: performedBy,
        status: dbPatch.status || row.status,
        notes,
      },
      meta: {
        performedAt, performedBy, result: resultText, resultStated: resultText !== null, passed,
        certificateNo: certificateRef, nextDueDate: nextDue, intervalDays: interval,
        nextDueSource: statedNext ? 'stated' : 'computed',
        outOfService: !passed,
        severityReason: passed ? 'calibration recorded' : 'calibration failed - equipment withdrawn from service',
      },
      gxpAreas: parseJson(row.gxp_areas, []),
      severity: 'critical',
    });
  });

  return getEquipment(row.id);
}

// ------------------------------------------------------- maintenance event --

/**
 * Record a preventive or corrective maintenance event (21 CFR 211.67, GLP 58.63(a)).
 *
 * Same shape as `recordCalibration`: updates the scheduling columns and writes
 * an audit entry. A stated non-pass outcome also takes the instrument out of
 * service, because an instrument that failed maintenance must not be used for
 * GxP work until its return to service is justified.
 *
 * @param {number|string} id      equipment id or asset number
 * @param {object} [payload]      {performedAt, performedBy, maintenanceType, result, workOrderNo, notes, nextDueDate, intervalDays, signatureId}
 */
function recordMaintenance(id, payload, actor, ctx, signatureId) {
  const row = resolveRow(id);
  if (!row) throw httpError(404, 'EQUIPMENT_NOT_FOUND', `No equipment with id/asset number "${id}"`);
  const p = payload || {};
  const sigId = resolveSignatureId(signatureId, p);

  const performedAt = dateOrToday(field(p, 'performedAt', 'performed_at'), 'performedAt');
  const statedInterval = intervalOrNull(field(p, 'intervalDays', 'interval_days'), 'intervalDays');
  let interval = statedInterval !== null ? statedInterval : numOrNull(row.maintenance_interval_days);
  const statedNext = dateOrNull(field(p, 'nextDueDate', 'next_due_date'), 'nextDueDate');
  const nextDue = statedNext || addDays(performedAt, interval !== null ? interval : DEFAULT_MAINTENANCE_INTERVAL_DAYS);
  if (interval === null && !statedNext) interval = DEFAULT_MAINTENANCE_INTERVAL_DAYS;

  const resultText = textOrNull(field(p, 'result', 'result'));
  const passed = resultText === null ? true : isPassResult(resultText);
  const maintenanceType = enumText(field(p, 'maintenanceType', 'maintenance_type')) ||
    (passed ? null : 'corrective');
  const workOrderNo = textOrNull(field(p, 'workOrderNo', 'work_order_no'));
  const description = textOrNull(field(p, 'description', 'description'));
  const performedBy = textOrNull(field(p, 'performedBy', 'performed_by'));
  const notes = textOrNull(field(p, 'notes', 'notes'));

  const dbPatch = {
    last_maintenance_date: performedAt,
    next_maintenance_date: nextDue,
    maintenance_interval_days: interval,
    updated_at: nowIso(),
  };
  if (!passed) dbPatch.status = 'out_of_service';

  const recordKey = recordKeyFor(row.id);
  const reason = `${maintenanceType === 'corrective' ? 'Corrective' : 'Preventive'} maintenance for ${row.asset_no} on ${performedAt}` +
    ` (next due ${nextDue || 'not scheduled'})${workOrderNo ? `, work order ${workOrderNo}` : ''}` +
    (passed ? '' : ' - instrument set out of service');

  db.transaction(() => {
    applyPatch('equipment', row.id, dbPatch);
    audit.append({
      action: maintenanceType === 'corrective' ? 'maintenance_corrective' : 'maintenance',
      entityType: 'equipment',
      entityId: row.id,
      recordKey,
      recordVersion: nextRecordVersion(recordKey),
      actor,
      reason,
      ctx,
      signatureId: sigId,
      oldValue: {
        last_maintenance_date: row.last_maintenance_date,
        next_maintenance_date: row.next_maintenance_date,
        maintenance_interval_days: row.maintenance_interval_days,
        status: row.status,
      },
      newValue: {
        last_maintenance_date: performedAt,
        next_maintenance_date: nextDue,
        maintenance_interval_days: interval,
        work_order_no: workOrderNo,
        maintenance_type: maintenanceType,
        result: resultText,
        performed_by: performedBy,
        status: dbPatch.status || row.status,
        notes,
      },
      meta: {
        performedAt, performedBy, maintenanceType, result: resultText, resultStated: resultText !== null,
        passed, workOrderNo, description, nextDueDate: nextDue, intervalDays: interval,
        nextDueSource: statedNext ? 'stated' : 'computed',
        outOfService: !passed,
      },
      gxpAreas: parseJson(row.gxp_areas, []),
      severity: passed ? (maintenanceType === 'corrective' ? 'warning' : 'info') : 'critical',
    });
  });

  return getEquipment(row.id);
}

// ---------------------------------------------------------- qualification ---

/** Accept a date, `true` (= today) or nothing for an IQ/OQ/PQ entry. */
function qualificationDate(value, name) {
  if (value === undefined || value === null || value === '' || value === false) return undefined;
  if (value === true) return today();
  return dateOrNull(value, name);
}

/**
 * Record IQ/OQ/PQ completion (EU GMP Annex 15 §3, GxP qualification lifecycle).
 *
 * Only the stages supplied are touched, so an IQ can be recorded today and the
 * OQ next week without erasing the first entry. When no explicit status is
 * given the qualification status is derived from the dates that are present.
 */
function setQualification(id, payload, actor, ctx, reason) {
  const row = resolveRow(id);
  if (!row) throw httpError(404, 'EQUIPMENT_NOT_FOUND', `No equipment with id/asset number "${id}"`);
  const p = payload || {};

  const dbPatch = {};
  const stages = [['iq', 'iq_date'], ['oq', 'oq_date'], ['pq', 'pq_date']];
  for (const [key, col] of stages) {
    const value = qualificationDate(field(p, key, col), key.toUpperCase());
    if (value !== undefined) dbPatch[col] = value;
  }

  const iq = 'iq_date' in dbPatch ? dbPatch.iq_date : row.iq_date;
  const oq = 'oq_date' in dbPatch ? dbPatch.oq_date : row.oq_date;
  const pq = 'pq_date' in dbPatch ? dbPatch.pq_date : row.pq_date;

  const requested = normaliseQualificationStatus(field(p, 'status', 'status'))
    || normaliseQualificationStatus(field(p, 'qualificationStatus', 'qualification_status'));
  const derived = deriveQualificationStatus(iq, oq, pq);
  const status = requested || derived || row.qualification_status;
  if (status !== row.qualification_status) dbPatch.qualification_status = status;

  const qualificationNote = [['IQ', iq], ['OQ', oq], ['PQ', pq]]
    .map(([label, value]) => `${label} ${value || '-'}`).join(', ');

  if (!Object.keys(dbPatch).length) {
    throw httpError(400, 'NOTHING_TO_UPDATE',
      `No qualification change supplied (current: ${qualificationNote}, status ${row.qualification_status || 'unset'})`);
  }

  const before = {};
  const after = {};
  for (const col of Object.keys(dbPatch)) { before[col] = row[col]; after[col] = dbPatch[col]; }
  dbPatch.updated_at = nowIso();

  const recordKey = recordKeyFor(row.id);
  const note = textOrNull(reason) || `Qualification recorded: ${qualificationNote}`;

  db.transaction(() => {
    applyPatch('equipment', row.id, dbPatch);
    audit.recordChange({
      actor,
      entityType: 'equipment',
      entityId: row.id,
      recordKey,
      recordVersion: nextRecordVersion(recordKey),
      before,
      after,
      reason: note,
      ctx,
      action: 'qualification',
      meta: { qualificationNote, status, qualificationComplete: Boolean(iq && oq && pq) },
      gxpAreas: parseJson(row.gxp_areas, []),
      severity: status === 'qualified' || status === 'disqualified' ? 'critical' : 'info',
    });
  });

  return getEquipment(row.id);
}

// ------------------------------------------------------------- reporting ----

const DUE_REPORT_COLUMNS =
  'id, asset_no, name, name_en, location, department, criticality, gxp_areas, status, ' +
  'last_calibration_date, next_calibration_date, calibration_interval_days';

/**
 * Calibration due/overdue report for a planning horizon.
 *
 * @param {number} [daysAhead] defaults to `config.reminder.calibrationWarningDays`
 * @returns {{overdue: object[], dueSoon: object[], byDepartment: object[], gxpCriticalOverdue: number, daysAhead: number}}
 */
function calibrationDueReport(daysAhead) {
  const requested = numOrNull(daysAhead);
  const days = requested !== null && requested >= 0 ? requested : calibrationWarningDays();
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const scope = "FROM equipment WHERE calibration_required = 1 AND status != 'retired' " +
    'AND next_calibration_date IS NOT NULL';

  const overdue = db.all(
    `SELECT ${DUE_REPORT_COLUMNS} ${scope} AND next_calibration_date < date('now') ` +
    'ORDER BY next_calibration_date ASC, id ASC'
  );
  const dueSoon = db.all(
    `SELECT ${DUE_REPORT_COLUMNS} ${scope} AND next_calibration_date >= date('now') ` +
    'AND next_calibration_date <= ? ORDER BY next_calibration_date ASC, id ASC',
    [horizon]
  );
  const byDepartment = db.all(
    `SELECT COALESCE(NULLIF(TRIM(department), ''), '(unassigned)') AS department,
            COUNT(*) AS total,
            SUM(CASE WHEN next_calibration_date < date('now') THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN next_calibration_date >= date('now') AND next_calibration_date <= ? THEN 1 ELSE 0 END) AS due_soon
     FROM equipment
     WHERE calibration_required = 1 AND status != 'retired'
     GROUP BY department
     ORDER BY overdue DESC, total DESC, department ASC`,
    [horizon]
  ).map((r) => ({
    department: r.department, total: r.total, overdue: r.overdue, dueSoon: r.due_soon,
  }));

  const criticalPlaceholders = GXP_CRITICAL_LEVELS.map(() => '?').join(', ');
  const gxpCriticalOverdue = db.get(
    `SELECT COUNT(*) AS n ${scope} AND next_calibration_date < date('now') ` +
    `AND criticality IN (${criticalPlaceholders})`,
    GXP_CRITICAL_LEVELS
  ).n;

  return {
    overdue: overdue.map(mapDueRow),
    dueSoon: dueSoon.map(mapDueRow),
    byDepartment,
    gxpCriticalOverdue,
    daysAhead: days,
  };
}

// ---------------------------------------------------- workflow integration --

/** Equipment criticality -> workflow criticality vocabulary. */
function toWorkflowCriticality(criticality) {
  switch (String(criticality || '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'major';
    case 'medium': return 'minor';
    case 'low': return 'minor';
    default: return null;
  }
}

function defaultWorkflowTitle(equip) {
  if (equip.calibrationStatus === 'overdue') {
    return `Calibration overdue: ${equip.assetNo} ${equip.name}`;
  }
  if (equip.calibrationStatus === 'due_soon') {
    return `Calibration due ${equip.nextCalibrationDate}: ${equip.assetNo} ${equip.name}`;
  }
  if (equip.maintenanceStatus === 'overdue') {
    return `Maintenance overdue: ${equip.assetNo} ${equip.name}`;
  }
  return `Equipment issue: ${equip.assetNo} ${equip.name}`;
}

function workflowSummary(equip) {
  return [
    `${equip.assetNo} - ${equip.name}${equip.nameEn ? ` / ${equip.nameEn}` : ''}`,
    equip.location ? `Location: ${equip.location}` : null,
    equip.department ? `Department: ${equip.department}` : null,
    `Calibration: ${equip.calibrationStatus}` +
      `${equip.lastCalibrationDate ? ` (last ${equip.lastCalibrationDate}` : ' (never calibrated'}` +
      `${equip.nextCalibrationDate ? `, next due ${equip.nextCalibrationDate})` : ')'}`,
    equip.maintenanceStatus !== 'not_required' ? `Maintenance: ${equip.maintenanceStatus}` : null,
    equip.qualificationComplete ? 'IQ/OQ/PQ complete' : 'IQ/OQ/PQ incomplete',
  ].filter(Boolean).join('\n');
}

/**
 * Default process code when the caller does not name one: the deviation route,
 * resolved against the process types this site actually has loaded (the seed
 * uses `DEV`). The engine still validates the code, so an unseeded instance
 * fails loudly rather than silently filing the record under a wrong process.
 */
function defaultProcessCode() {
  for (const candidate of ['DEV', 'deviation', 'OOS', 'CHG']) {
    if (db.get('SELECT code FROM process_types WHERE code = ? AND active = 1', [candidate])) return candidate;
  }
  return 'DEV';
}

/**
 * Turn an instrument into a linked process record (deviation, change control,
 * CAPA, ...) in one click - the normal reaction to an out-of-calibration or
 * out-of-service instrument.
 *
 * `workflow.js` is required lazily *inside* the function body: it is the
 * generic engine, and a top-level require would create a cycle as soon as
 * workflow automation starts raising equipment records.
 *
 * @returns {object} the created instance, augmented with the equipment linkage
 */
function raiseWorkflowForEquipment(equipmentId, processCode, title, actor, ctx) {
  const row = resolveRow(equipmentId);
  if (!row) throw httpError(404, 'EQUIPMENT_NOT_FOUND', `No equipment with id/asset number "${equipmentId}"`);

  const workflow = require('./workflow');
  const equip = mapEquipment(row);
  const gxpAreas = parseJson(row.gxp_areas, []);
  const code = textOrNull(processCode) || defaultProcessCode();

  // Process definitions declare required fields (the seeded DEV process needs
  // title/summary/occurredAt/criticality), so the linkage always fills them:
  // the occurrence is the calibration due date (or the last calibration, or
  // today when the instrument has never been calibrated).
  const occurredAt = equip.nextCalibrationDate || equip.lastCalibrationDate || today();
  const criticality = toWorkflowCriticality(row.criticality) || 'major';

  const instance = workflow.createInstance({
    processCode: code,
    title: textOrNull(title) || defaultWorkflowTitle(equip),
    summary: workflowSummary(equip),
    department: row.department || null,
    gxpAreas,
    criticality,
    linkType: 'equipment',
    sourceEntityType: 'equipment',
    sourceEntityId: String(row.id),
    occurredAt,
    detectedAt: nowIso(),
    data: {
      equipmentId: row.id,
      assetNo: row.asset_no,
      asset_no: row.asset_no,
      equipmentName: row.name,
      name: row.name,
      serialNo: row.serial_no,
      manufacturer: row.manufacturer,
      model: row.model,
      location: row.location,
      department: row.department,
      summary: workflowSummary(equip),
      occurredAt,
      criticality,
      equipmentCriticality: row.criticality,
      calibrationStatus: equip.calibrationStatus,
      calibration_status: equip.calibrationStatus,
      lastCalibrationDate: equip.lastCalibrationDate,
      nextCalibrationDate: equip.nextCalibrationDate,
      maintenanceStatus: equip.maintenanceStatus,
      nextMaintenanceDate: equip.nextMaintenanceDate,
      qualificationStatus: equip.qualificationStatus,
      qualificationComplete: equip.qualificationComplete,
      notes: row.notes,
    },
  }, actor, ctx);

  const recordKey = recordKeyFor(row.id);
  audit.append({
    action: 'raise_workflow',
    entityType: 'equipment',
    entityId: row.id,
    recordKey,
    recordVersion: nextRecordVersion(recordKey),
    actor,
    reason: `Raised ${code} ${instance.recordKey} from equipment ${row.asset_no} (${equip.calibrationStatus})`,
    ctx,
    oldValue: { calibration_status: equip.calibrationStatus, status: row.status },
    newValue: {
      workflow_id: instance.id, workflow_record_key: instance.recordKey,
      process_code: code, source_entity_type: 'equipment', source_entity_id: String(row.id),
    },
    meta: { sourceEntityType: 'equipment', sourceEntityId: String(row.id), assetNo: row.asset_no },
    gxpAreas,
    severity: 'warning',
  });

  return {
    ...instance,
    sourceEntityType: 'equipment',
    sourceEntityId: String(row.id),
    equipmentId: row.id,
    assetNo: row.asset_no,
  };
}

// --------------------------------------------------------------- metrics ----

/** Register KPIs used by the compliance dashboard. */
function metrics() {
  const horizon = new Date(Date.now() + calibrationWarningDays() * 86400000).toISOString().slice(0, 10);
  const criticalPlaceholders = GXP_CRITICAL_LEVELS.map(() => '?').join(', ');
  const count = (sql, params) => db.get(sql, params).n;

  return {
    total: count('SELECT COUNT(*) AS n FROM equipment'),
    inService: count("SELECT COUNT(*) AS n FROM equipment WHERE status = 'in_service'"),
    outOfService: count("SELECT COUNT(*) AS n FROM equipment WHERE status = 'out_of_service'"),
    overdueCalibration: count(
      "SELECT COUNT(*) AS n FROM equipment WHERE calibration_required = 1 " +
      "AND next_calibration_date IS NOT NULL AND next_calibration_date < date('now')"
    ),
    dueSoonCalibration: count(
      "SELECT COUNT(*) AS n FROM equipment WHERE calibration_required = 1 " +
      "AND next_calibration_date IS NOT NULL AND next_calibration_date >= date('now') " +
      'AND next_calibration_date <= ?',
      [horizon]
    ),
    overdueMaintenance: count(
      'SELECT COUNT(*) AS n FROM equipment WHERE next_maintenance_date IS NOT NULL ' +
      "AND next_maintenance_date < date('now')"
    ),
    qualificationGaps: count(
      "SELECT COUNT(*) AS n FROM equipment WHERE status = 'in_service' " +
      `AND criticality IN (${criticalPlaceholders}) ` +
      'AND (iq_date IS NULL OR oq_date IS NULL OR pq_date IS NULL)',
      GXP_CRITICAL_LEVELS
    ),
    csvPending: count(
      "SELECT COUNT(*) AS n FROM equipment WHERE status = 'in_service' " +
      "AND csv_status IN ('pending', 'not_started')"
    ),
  };
}

module.exports = {
  createEquipment,
  updateEquipment,
  getEquipment,
  listEquipment,
  recordCalibration,
  recordMaintenance,
  setQualification,
  calibrationDueReport,
  raiseWorkflowForEquipment,
  metrics,
  // constants / helpers reused by the HTTP layer and the UI
  STATUSES,
  QUALIFICATION_STATUSES,
  CRITICALITY_LEVELS,
  GXP_CRITICAL_LEVELS,
  CALIBRATION_STATUSES,
  PASS_RESULTS,
  ALLOWED_UPDATE_COLUMNS,
  DATE_COLUMNS,
  DEFAULT_CALIBRATION_INTERVAL_DAYS,
  DEFAULT_MAINTENANCE_INTERVAL_DAYS,
  calibrationWarningDays,
  isPassResult,
  scheduleStatus,
  toSnake,
  httpError,
};
