-- Cycle 0 — Geofence enforcement at punch time (FLAG: additive only).
--
-- Wires the previously-dead geofence path: derive.js already READS
-- ctx.flags.outOfGeofence (OUT_OF_GEOFENCE exception) but service.js never set it.
-- This migration adds the policy lever + the per-punch marker the wiring needs.
--
-- ADDITIVE only — new nullable columns + one column with a safe default. No table
-- drops, no data backfill, no NOT NULL on existing rows. Safe to apply on a live
-- tenant (mirrors feature10/13/19 additive migrations). IF NOT EXISTS keeps it
-- idempotent against a schema that was previously `db push`-ed.
--
-- Policy (Location.geofenceEnforce): false (default) = WARN ONLY — flag + surface
-- the OUT_OF_GEOFENCE exception but never block; true = ENFORCE. Default warn so a
-- freshly-configured geofence never locks anyone out on day one.

ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "geofenceEnforce" BOOLEAN NOT NULL DEFAULT false;

-- Per-punch geofence evaluation marker. null = not evaluated (no location geofence
-- or the punch carried no coords); false = inside the radius; true = outside.
ALTER TABLE "AttendancePunch"
  ADD COLUMN IF NOT EXISTS "outOfGeofence" BOOLEAN;

-- Haversine distance (metres) from the assigned location at punch time, when evaluated.
ALTER TABLE "AttendancePunch"
  ADD COLUMN IF NOT EXISTS "geoDistanceM" INTEGER;
