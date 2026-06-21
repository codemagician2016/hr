-- P2 — per-item substitution preference. NULL = inherit Order.substitutionPolicy.
-- Values: 'AUTO' | 'APPROVE' | 'REFUND' (same vocabulary as order-level policy).
ALTER TABLE "CartItem"  ADD COLUMN "substitutionPref" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "substitutionPref" TEXT;
