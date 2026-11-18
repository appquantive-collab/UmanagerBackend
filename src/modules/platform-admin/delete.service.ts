import mongoose, { Types } from "mongoose";
import { PhoneOtp } from "../../models/PhoneOtp";
import { Tenant } from "../../models/Tenant";
import { User } from "../../models/User";
import { forgetAccountState } from "../../middleware/accountGate";

/**
 * Permanent deletes from the founder's console. Cannot be undone.
 * A business takes everything it owns with it (every collection that has a
 * tenantId), except what the founder's own books need: plan payments (revenue)
 * and AI call costs, which stay and show as a deleted business.
 */
const KEEP_FOR_REPORTS = new Set(["AiCall", "SubscriptionPayment"]);

export class DeleteError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string
  ) {
    super(message);
    this.name = "DeleteError";
  }
}

export async function deleteBusiness(tenantId: string): Promise<{ businessName: string; removed: Record<string, number> }> {
  if (!Types.ObjectId.isValid(tenantId)) throw new DeleteError("Business not found", 404);
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw new DeleteError("Business not found", 404);
  const tid = new Types.ObjectId(tenantId);

  const users = await User.find({ tenantId: tid }, { phone: 1 }).lean();
  const removed: Record<string, number> = {};
  for (const name of mongoose.modelNames()) {
    if (KEEP_FOR_REPORTS.has(name)) continue;
    const model = mongoose.model(name);
    if (!model.schema.path("tenantId")) continue;
    const { deletedCount } = await model.deleteMany({ tenantId: tid });
    if (deletedCount) removed[name] = deletedCount;
  }
  const phones = users.map((u) => u.phone).filter((p): p is string => Boolean(p));
  if (phones.length) await PhoneOtp.deleteMany({ phone: { $in: phones } });
  await Tenant.deleteOne({ _id: tid });

  forgetAccountState({ tenantId });
  for (const u of users) forgetAccountState({ userId: String(u._id) });
  return { businessName: tenant.businessName, removed };
}

/**
 * Delete one login. A staff login just goes. The owner of a business can only
 * be deleted together with the business (withBusiness), so no business is left
 * without its owner. VoiceMunshi admin logins are never deleted from here.
 */
export async function deleteUser(userId: string, actingAdminId: string, withBusiness: boolean) {
  if (!Types.ObjectId.isValid(userId)) throw new DeleteError("User not found", 404);
  if (userId === actingAdminId) throw new DeleteError("You can't delete your own login.");
  const user = await User.findById(userId);
  if (!user) throw new DeleteError("User not found", 404);
  if (user.role === "PLATFORM_ADMIN") throw new DeleteError("Admin logins can't be deleted from here.");

  if (user.role === "OWNER" && user.tenantId) {
    const otherOwners = await User.countDocuments({ tenantId: user.tenantId, role: "OWNER", _id: { $ne: user._id } });
    if (otherOwners === 0) {
      if (!withBusiness) {
        throw new DeleteError("This is the business owner. Deleting them deletes the whole business and all its data.", 409, "OWNER_HAS_BUSINESS");
      }
      const result = await deleteBusiness(String(user.tenantId));
      return { deleted: "business" as const, ...result };
    }
  }

  if (user.phone) await PhoneOtp.deleteMany({ phone: user.phone });
  await User.deleteOne({ _id: user._id });
  forgetAccountState({ userId });
  return { deleted: "user" as const, name: user.name };
}
