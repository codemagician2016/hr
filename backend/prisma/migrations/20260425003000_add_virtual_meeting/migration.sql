-- Virtual / online consultation support. Provider-agnostic — admin
-- pastes a meeting URL (Google Meet / Zoom / MS Teams / Whereby /
-- Jitsi / etc) and it flows into customer confirmation + reminder
-- emails. Two layers:
--   * Service.virtualMeetingUrl — default link per service
--   * Appointment.meetingUrl    — per-booking override

ALTER TABLE "Service"
  ADD COLUMN "isVirtual" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "virtualMeetingUrl" TEXT;

ALTER TABLE "Appointment"
  ADD COLUMN "meetingUrl" TEXT;
