import { Types } from "mongoose";
import { Product, type BomLine } from "../../models/Product";
import { StockMovement } from "../../models/StockMovement";

// A product's BOM may only reference other products flagged isRawMaterial —
// never another finished/assembled product — so there is no possibility of a
// circular or multi-level BOM to resolve. Called whenever a product's bom
// field is written (create or update).
export async function validateBom(tenantId: string, bom: BomLine[] | { rawMaterialId: string; quantity: number; unit: string }[]) {
  if (bom.length === 0) return;

  const ids = bom.map((line) => String(line.rawMaterialId));
  const rawMaterials = await Product.find({ _id: { $in: ids }, tenantId, isRawMaterial: true });

  const foundIds = new Set(rawMaterials.map((r) => String(r._id)));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `One or more BOM items are not valid raw materials for this business: ${missing.join(", ")}`
    );
  }
}

export interface RawMaterialAvailability {
  rawMaterialId: string;
  rawMaterialName: string;
  requiredPerUnit: number;
  unit: string;
  currentStock: number;
}

export interface ProducibleResult {
  producibleQuantity: number;
  rawMaterials: RawMaterialAvailability[];
}

// How many finished units could be assembled right now given current raw
// material stock — the minimum across every BOM line of (stock ÷ required
// quantity), floored, since you can't assemble a fractional unit.
export async function getProducibleQuantity(tenantId: string, productId: string): Promise<ProducibleResult> {
  const product = await Product.findOne({ _id: productId, tenantId });
  if (!product) throw new Error("Product not found");
  if (product.bom.length === 0) {
    return { producibleQuantity: Infinity, rawMaterials: [] };
  }

  const tenantObjectId = new Types.ObjectId(tenantId);
  const rawMaterialIds = product.bom.map((line) => line.rawMaterialId);

  const [rawMaterials, stockTotals] = await Promise.all([
    Product.find({ _id: { $in: rawMaterialIds }, tenantId }),
    StockMovement.aggregate([
      { $match: { tenantId: tenantObjectId, productId: { $in: rawMaterialIds } } },
      { $group: { _id: "$productId", quantity: { $sum: "$quantity" } } },
    ]),
  ]);

  const nameById = new Map(rawMaterials.map((r) => [String(r._id), r.name]));
  const stockById = new Map(stockTotals.map((row) => [String(row._id), row.quantity as number]));

  const rawMaterialDetails: RawMaterialAvailability[] = product.bom.map((line) => ({
    rawMaterialId: String(line.rawMaterialId),
    rawMaterialName: nameById.get(String(line.rawMaterialId)) ?? "Unknown",
    requiredPerUnit: line.quantity,
    unit: line.unit,
    currentStock: stockById.get(String(line.rawMaterialId)) ?? 0,
  }));

  const producibleQuantity = Math.min(
    ...rawMaterialDetails.map((r) => Math.floor(r.currentStock / r.requiredPerUnit))
  );

  return { producibleQuantity: Math.max(0, producibleQuantity), rawMaterials: rawMaterialDetails };
}

export interface AssembleResult {
  producedQuantity: number;
  shortfall: RawMaterialAvailability[]; // raw materials that went negative to fulfill this
}

// Converts raw materials into finished-product stock: deducts (bom qty ×
// quantity) of each raw material and adds `quantity` of the finished product,
// all tagged with the same referenceId so the ledger entries read as one event.
// Unlike a normal stock movement, this is allowed to push a raw material
// negative — the user may be assembling ahead of a known incoming delivery —
// but every such case is reported back as a shortfall for the UI to flag.
export async function assembleProduct(
  tenantId: string,
  userId: string,
  productId: string,
  warehouseId: string,
  quantity: number,
  note?: string
): Promise<AssembleResult> {
  const product = await Product.findOne({ _id: productId, tenantId });
  if (!product) throw new Error("Product not found");
  if (product.bom.length === 0) throw new Error("This product has no raw materials configured");

  const tenantObjectId = new Types.ObjectId(tenantId);
  const warehouseObjectId = new Types.ObjectId(warehouseId);
  const rawMaterialIds = product.bom.map((line) => line.rawMaterialId);

  const [rawMaterials, stockTotals] = await Promise.all([
    Product.find({ _id: { $in: rawMaterialIds }, tenantId }),
    StockMovement.aggregate([
      { $match: { tenantId: tenantObjectId, warehouseId: warehouseObjectId, productId: { $in: rawMaterialIds } } },
      { $group: { _id: "$productId", quantity: { $sum: "$quantity" } } },
    ]),
  ]);
  const nameById = new Map(rawMaterials.map((r) => [String(r._id), r.name]));
  const stockById = new Map(stockTotals.map((row) => [String(row._id), row.quantity as number]));

  const referenceId = new Types.ObjectId().toString();
  const shortfall: RawMaterialAvailability[] = [];

  const consumeMovements = product.bom.map((line) => {
    const required = line.quantity * quantity;
    const available = stockById.get(String(line.rawMaterialId)) ?? 0;
    if (available - required < 0) {
      shortfall.push({
        rawMaterialId: String(line.rawMaterialId),
        rawMaterialName: nameById.get(String(line.rawMaterialId)) ?? "Unknown",
        requiredPerUnit: line.quantity,
        unit: line.unit,
        currentStock: available,
      });
    }
    return {
      tenantId,
      productId: line.rawMaterialId,
      warehouseId,
      quantity: -required,
      movementType: "assembly_consume" as const,
      note: note ?? `Consumed to assemble ${quantity} × ${product.name}`,
      referenceId,
      createdBy: userId,
    };
  });

  const produceMovement = {
    tenantId,
    productId: product._id,
    warehouseId,
    quantity,
    movementType: "assembly_produce" as const,
    note: note ?? `Assembled from raw materials`,
    referenceId,
    createdBy: userId,
  };

  await StockMovement.insertMany([...consumeMovements, produceMovement]);

  return { producedQuantity: quantity, shortfall };
}
