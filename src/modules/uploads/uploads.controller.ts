import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { requireAuth, requireTenant } from "../../middleware/auth";
import { env } from "../../config/env";

export const uploadsRouter = Router();

uploadsRouter.use(requireAuth, requireTenant);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

uploadsRouter.post("/product-image", upload.single("image"), async (req, res) => {
  if (!env.cloudinaryConfigured) {
    return res.status(503).json({ error: "Image upload is not configured yet. Contact your administrator." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No image file provided" });
  }

  try {
    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: `umanager/${req.auth!.tenantId}/products`, resource_type: "image" },
        (error, uploadResult) => {
          if (error || !uploadResult) return reject(error ?? new Error("Upload failed"));
          resolve(uploadResult);
        }
      );
      uploadStream.end(req.file!.buffer);
    });

    res.status(201).json({ url: result.secure_url });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message || "Image upload failed" });
  }
});
