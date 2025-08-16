-- CreateTable
CREATE TABLE "public"."ProductAttr" (
    "productId" TEXT NOT NULL,
    "category" TEXT,
    "season" TEXT,
    "gender" TEXT,
    "lifecycle" TEXT,

    CONSTRAINT "ProductAttr_pkey" PRIMARY KEY ("productId")
);

-- CreateTable
CREATE TABLE "public"."InventorySnapshot" (
    "id" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL,
    "price" DECIMAL(10,2),
    "cost" DECIMAL(10,2),

    CONSTRAINT "InventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventorySnapshot_snapshotDate_idx" ON "public"."InventorySnapshot"("snapshotDate");

-- CreateIndex
CREATE INDEX "InventorySnapshot_variantId_snapshotDate_idx" ON "public"."InventorySnapshot"("variantId", "snapshotDate");

-- AddForeignKey
ALTER TABLE "public"."ProductAttr" ADD CONSTRAINT "ProductAttr_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

