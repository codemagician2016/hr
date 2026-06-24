'use strict';

/**
 * devices.controller.js — thin operator surface for the Feature 28 device registry,
 * mapping, raw-event triage, reprocess + manual correction. Tenant-scoped by
 * req.user.businessId; all routes are canManageAttendance-gated (the routes attach
 * the gate). The push/poll INGEST doors are NOT here — they are device-secret-authed
 * (webhook.controller) / cron-driven (poll.runner).
 */

const service = require('./devices.service');

function actor(req) { return { businessId: req.user.businessId, actorId: req.user.id }; }
function handle(res, next, p) {
  return p.then((data) => res.json(data)).catch((e) => {
    if (e && e.statusCode) return res.status(e.statusCode).json({ message: e.message, code: e.code });
    return next(e);
  });
}

// Devices
function meta(req, res, next) { try { return res.json(service.meta()); } catch (e) { return next(e); } }
function listDevices(req, res, next) { const { businessId } = actor(req); return handle(res, next, service.listDevices({ businessId, entityId: req.query.entityId, locationId: req.query.locationId, query: req.query })); }
function getDevice(req, res, next) { const { businessId } = actor(req); return handle(res, next, service.getDevice({ businessId, id: req.params.id })); }
function createDevice(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.createDevice({ businessId, actorId, body: req.body })); }
function updateDevice(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.updateDevice({ businessId, actorId, id: req.params.id, body: req.body })); }
function deleteDevice(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.deleteDevice({ businessId, actorId, id: req.params.id })); }
function rotateSecret(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.rotateSecret({ businessId, actorId, id: req.params.id })); }

// Events / triage
function listEvents(req, res, next) { const { businessId } = actor(req); return handle(res, next, service.listEvents({ businessId, deviceId: req.params.id || req.query.deviceId, status: req.query.status, from: req.query.from, to: req.query.to, query: req.query })); }
function unmappedCodes(req, res, next) { const { businessId } = actor(req); return handle(res, next, service.unmappedCodes({ businessId, days: Number(req.query.days) || 7 })); }

// Mapping CRUD
function listMaps(req, res, next) { const { businessId } = actor(req); return handle(res, next, service.listMaps({ businessId, deviceId: req.query.deviceId, query: req.query })); }
function createMap(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.createMap({ businessId, actorId, body: req.body })); }
function deleteMap(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.deleteMap({ businessId, actorId, id: req.params.id })); }
function bulkMaps(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.bulkMaps({ businessId, actorId, deviceId: req.body && req.body.deviceId, contentBase64: req.body && req.body.contentBase64 })); }

// Reprocess + correct
function reprocess(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.reprocess({ businessId, actorId, statuses: req.body && req.body.statuses, deviceId: req.body && req.body.deviceId })); }
function correct(req, res, next) { const { businessId, actorId } = actor(req); return handle(res, next, service.correctEvent({ businessId, actorId, id: req.params.id, action: req.body && req.body.action, employeeId: req.body && req.body.employeeId })); }

module.exports = {
  meta, listDevices, getDevice, createDevice, updateDevice, deleteDevice, rotateSecret,
  listEvents, unmappedCodes, listMaps, createMap, deleteMap, bulkMaps, reprocess, correct,
};
