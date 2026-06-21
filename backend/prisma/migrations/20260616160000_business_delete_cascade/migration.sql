-- Hard-deleting a tenant (super-admin) failed with a foreign-key error (P2003)
-- because a handful of Business-referencing tables had no ON DELETE CASCADE, so
-- their rows pinned the Business row. The other ~92 relations already cascade;
-- these 7 were the gaps. Switch each businessId FK to ON DELETE CASCADE so a
-- Business delete cleanly removes all of its data. (One relation — line 1610 —
-- intentionally stays SET NULL and is untouched.)
ALTER TABLE "User"         DROP CONSTRAINT "User_businessId_fkey";
ALTER TABLE "User"         ADD CONSTRAINT "User_businessId_fkey"         FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Customer"     DROP CONSTRAINT "Customer_businessId_fkey";
ALTER TABLE "Customer"     ADD CONSTRAINT "Customer_businessId_fkey"     FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_businessId_fkey";
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Service"      DROP CONSTRAINT "Service_businessId_fkey";
ALTER TABLE "Service"      ADD CONSTRAINT "Service_businessId_fkey"      FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Waitlist"     DROP CONSTRAINT "Waitlist_businessId_fkey";
ALTER TABLE "Waitlist"     ADD CONSTRAINT "Waitlist_businessId_fkey"     FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Appointment"  DROP CONSTRAINT "Appointment_businessId_fkey";
ALTER TABLE "Appointment"  ADD CONSTRAINT "Appointment_businessId_fkey"  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StaffLeave"   DROP CONSTRAINT "StaffLeave_businessId_fkey";
ALTER TABLE "StaffLeave"   ADD CONSTRAINT "StaffLeave_businessId_fkey"   FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
