-- CreateIndex
CREATE INDEX "Customer_depotId_idx" ON "Customer"("depotId");

-- CreateIndex
CREATE INDEX "Customer_depotId_isActive_idx" ON "Customer"("depotId", "isActive");

-- CreateIndex
CREATE INDEX "Customer_totalDebt_idx" ON "Customer"("totalDebt");

-- CreateIndex
CREATE INDEX "Payment_depotId_idx" ON "Payment"("depotId");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Product_depotId_idx" ON "Product"("depotId");

-- CreateIndex
CREATE INDEX "Product_depotId_isActive_idx" ON "Product"("depotId", "isActive");

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "Product"("name");

-- CreateIndex
CREATE INDEX "Sale_depotId_idx" ON "Sale"("depotId");

-- CreateIndex
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");

-- CreateIndex
CREATE INDEX "Sale_soldById_idx" ON "Sale"("soldById");

-- CreateIndex
CREATE INDEX "Sale_createdAt_idx" ON "Sale"("createdAt");

-- CreateIndex
CREATE INDEX "Sale_depotId_createdAt_idx" ON "Sale"("depotId", "createdAt");

-- CreateIndex
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");

-- CreateIndex
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");

-- CreateIndex
CREATE INDEX "StockMovement_depotId_idx" ON "StockMovement"("depotId");

-- CreateIndex
CREATE INDEX "StockMovement_productId_idx" ON "StockMovement"("productId");

-- CreateIndex
CREATE INDEX "StockMovement_createdAt_idx" ON "StockMovement"("createdAt");

-- CreateIndex
CREATE INDEX "User_depotId_idx" ON "User"("depotId");

-- CreateIndex
CREATE INDEX "User_depotId_role_idx" ON "User"("depotId", "role");

-- CreateIndex
CREATE INDEX "User_depotId_isActive_idx" ON "User"("depotId", "isActive");
