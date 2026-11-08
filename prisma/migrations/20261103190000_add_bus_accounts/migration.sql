-- AlterTable
ALTER TABLE "Bus" ADD COLUMN "hasWifi" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "officeId" TEXT;

-- CreateTable
CREATE TABLE "BusOffice" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "contactName" TEXT,
    "contractNumber" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusOffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusOfficeRate" (
    "id" TEXT NOT NULL,
    "officeId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "BusOfficeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusOfficePayment" (
    "id" TEXT NOT NULL,
    "officeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "paidAt" DATE NOT NULL,
    "createdById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusOfficePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripBusCost" (
    "tripId" TEXT NOT NULL,
    "driverExpense" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "delegationExpense" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripBusCost_pkey" PRIMARY KEY ("tripId")
);

-- CreateTable
CREATE TABLE "DriverProfile" (
    "userId" TEXT NOT NULL,
    "iqamaNumber" TEXT,
    "nationality" TEXT,
    "licenseExpiry" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "Bus_officeId_idx" ON "Bus"("officeId");

-- CreateIndex
CREATE UNIQUE INDEX "BusOffice_name_key" ON "BusOffice"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BusOfficeRate_officeId_origin_destination_key" ON "BusOfficeRate"("officeId", "origin", "destination");

-- CreateIndex
CREATE INDEX "BusOfficePayment_officeId_month_idx" ON "BusOfficePayment"("officeId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "DriverProfile_iqamaNumber_key" ON "DriverProfile"("iqamaNumber");

-- AddForeignKey
ALTER TABLE "Bus" ADD CONSTRAINT "Bus_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "BusOffice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusOfficeRate" ADD CONSTRAINT "BusOfficeRate_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "BusOffice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusOfficePayment" ADD CONSTRAINT "BusOfficePayment_officeId_fkey" FOREIGN KEY ("officeId") REFERENCES "BusOffice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripBusCost" ADD CONSTRAINT "TripBusCost_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriverProfile" ADD CONSTRAINT "DriverProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ranks that already see hotel costs handle the same work for buses; everyone else keeps exactly the access they had.
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['buses.view', 'buses.rates', 'buses.accounts'])
  WHERE "id" = 'rank-accountant' AND NOT 'buses.view' = ANY("permissions");
UPDATE "Rank" SET "permissions" = array_cat("permissions", ARRAY['buses.rates', 'buses.accounts'])
  WHERE ("id" = 'rank-operations' OR "id" = 'rank-accountant') AND NOT 'buses.rates' = ANY("permissions");
