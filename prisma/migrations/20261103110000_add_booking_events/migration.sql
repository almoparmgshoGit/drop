-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingEvent_bookingId_createdAt_idx" ON "BookingEvent"("bookingId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The booking history is append-only: nothing, including the application, can rewrite or remove an entry.
CREATE FUNCTION "reject_booking_event_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'BookingEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BookingEvent_append_only"
BEFORE UPDATE OR DELETE ON "BookingEvent"
FOR EACH ROW EXECUTE FUNCTION "reject_booking_event_change"();
