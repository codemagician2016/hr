'use strict';
// Employee documents + document requests. Mounted by the lead at /api/hr/documents.
//
// Reading documents/requests requires canViewEmployees; uploading, editing,
// deleting and fulfilling requires canManageEmployees. Everything is tenant-scoped
// (req.user.businessId) and, for the per-employee resources, scoped to the
// :employeeId in the path.
//
// Schema dependency (not yet defined in schema.prisma — see notes): models
// EmployeeDocument and DocumentRequest. Suggested shape this controller targets:
//
//   model EmployeeDocument {
//     id           String    @id @default(uuid())
//     businessId   String
//     business     Business  @relation(fields: [businessId], references: [id], onDelete: Cascade)
//     employeeId   String
//     employee     Employee  @relation(fields: [employeeId], references: [id], onDelete: Cascade)
//     type         String                 // e.g. "ID_PROOF", "CONTRACT", "CERTIFICATE"
//     name         String
//     url          String
//     fileName     String?
//     mimeType     String?
//     fileSize     Int?
//     notes        String?   @db.Text
//     issuedAt     DateTime?
//     expiresAt    DateTime?
//     uploadedById String?
//     requests     DocumentRequest[]      // requests fulfilled by this document
//     deletedAt    DateTime?
//     createdAt    DateTime  @default(now())
//     updatedAt    DateTime  @updatedAt
//     @@index([businessId, employeeId])
//     @@index([businessId, expiresAt])
//   }
//
//   model DocumentRequest {
//     id            String    @id @default(uuid())
//     businessId    String
//     business      Business  @relation(fields: [businessId], references: [id], onDelete: Cascade)
//     employeeId    String
//     employee      Employee  @relation(fields: [employeeId], references: [id], onDelete: Cascade)
//     type          String                // e.g. "EMPLOYMENT_LETTER", "SALARY_CERTIFICATE"
//     subject       String?
//     purpose       String?   @db.Text
//     notes         String?   @db.Text
//     status        String    @default("PENDING") // PENDING|IN_PROGRESS|FULFILLED|REJECTED
//     requestedById String?
//     handledById   String?
//     documentId    String?
//     document      EmployeeDocument? @relation(fields: [documentId], references: [id], onDelete: SetNull)
//     fulfilledAt   DateTime?
//     createdAt     DateTime  @default(now())
//     updatedAt     DateTime  @updatedAt
//     @@index([businessId, employeeId, status])
//   }
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/documents.controller');

// All document routes require an authenticated operator.
router.use(protect);

// Tenant-wide "documents needing attention" report (expired / expiring soon).
router.get('/expiring', requirePermission('canViewEmployees'), c.expiringDocuments);

// ---- EmployeeDocument (per employee) --------------------------------------
router.get('/employees/:employeeId/documents', requirePermission('canViewEmployees'), c.listDocuments);
router.get('/employees/:employeeId/documents/:id', requirePermission('canViewEmployees'), c.getDocument);
router.post('/employees/:employeeId/documents', requirePermission('canManageEmployees'), c.createDocument);
router.patch('/employees/:employeeId/documents/:id', requirePermission('canManageEmployees'), c.updateDocument);
router.delete('/employees/:employeeId/documents/:id', requirePermission('canManageEmployees'), c.removeDocument);

// ---- DocumentRequest (per employee) ---------------------------------------
router.get('/employees/:employeeId/requests', requirePermission('canViewEmployees'), c.listRequests);
router.get('/employees/:employeeId/requests/:id', requirePermission('canViewEmployees'), c.getRequest);
router.post('/employees/:employeeId/requests', requirePermission('canManageEmployees'), c.createRequest);
router.post('/employees/:employeeId/requests/:id/start', requirePermission('canManageEmployees'), c.startRequest);
router.post('/employees/:employeeId/requests/:id/fulfil', requirePermission('canManageEmployees'), c.fulfilRequest);
router.post('/employees/:employeeId/requests/:id/reject', requirePermission('canManageEmployees'), c.rejectRequest);

module.exports = router;
