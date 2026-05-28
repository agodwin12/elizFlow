-- CreateEnum
CREATE TYPE "TourneeStatus" AS ENUM ('PLANNED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StopStatus" AS ENUM ('PENDING', 'DELIVERED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "Tournee" (
    "id" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "TourneeStatus" NOT NULL DEFAULT 'PLANNED',
    "note" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryStop" (
    "id" TEXT NOT NULL,
    "tourneeId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "depotId" TEXT NOT NULL,
    "status" "StopStatus" NOT NULL DEFAULT 'PENDING',
    "plannedItems" JSONB NOT NULL,
    "deliveredItems" JSONB,
    "returnedItems" JSONB,
    "amountExpected" DOUBLE PRECISION NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "debtCreated" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "smsSent" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryStop_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Tournee" ADD CONSTRAINT "Tournee_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournee" ADD CONSTRAINT "Tournee_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournee" ADD CONSTRAINT "Tournee_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_tourneeId_fkey" FOREIGN KEY ("tourneeId") REFERENCES "Tournee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStop" ADD CONSTRAINT "DeliveryStop_depotId_fkey" FOREIGN KEY ("depotId") REFERENCES "Depot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
