-- CreateEnum
CREATE TYPE "public"."DiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateTable
CREATE TABLE "public"."BundleDef" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bundleProductId" TEXT,
    "discountType" "public"."DiscountType",
    "discountValue" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BundleDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CombinedParent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "parentProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CombinedParent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CombinedChild" (
    "id" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "parentOptionMap" JSONB,

    CONSTRAINT "CombinedChild_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BundleDef_shop_idx" ON "public"."BundleDef"("shop");

-- CreateIndex
CREATE INDEX "BundleItem_bundleId_idx" ON "public"."BundleItem"("bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "CombinedParent_parentProductId_key" ON "public"."CombinedParent"("parentProductId");

-- CreateIndex
CREATE INDEX "CombinedParent_shop_idx" ON "public"."CombinedParent"("shop");

-- CreateIndex
CREATE INDEX "CombinedChild_parentId_idx" ON "public"."CombinedChild"("parentId");

-- AddForeignKey
ALTER TABLE "public"."BundleItem" ADD CONSTRAINT "BundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "public"."BundleDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CombinedChild" ADD CONSTRAINT "CombinedChild_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."CombinedParent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
