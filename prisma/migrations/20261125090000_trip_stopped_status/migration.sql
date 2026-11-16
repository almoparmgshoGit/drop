-- The office can stop a trip that has started, and later resume it from where the crew last reported it.
ALTER TYPE "TripLiveStatus" ADD VALUE IF NOT EXISTS 'STOPPED';
