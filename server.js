import "dotenv/config";
import cors from "cors";
import express from "express";
import { clerkMiddleware } from "@clerk/express";

import prisma from "./src/config/prisma.js";
import clerkWebhook from "./src/routes/clerkWebhook.js";
import adminRoutes from "./src/routes/adminRoutes.js";
import documentRoutes from "./src/routes/documentRoutes.js";
import userRoutes from "./src/routes/userRoutes.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5174")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  allowedHeaders: ["Authorization", "Content-Type", "X-File-Name", "X-File-Type", "X-Document-Title", "X-Document-Description", "X-Document-Category", "X-Document-Tags"],
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  credentials: true,
}));

// Keep the signed webhook endpoint before JSON parsing and Clerk session middleware.
app.use("/api/webhooks", clerkWebhook);
app.use(express.json({ limit: "1mb" }));
app.use(clerkMiddleware());

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/documents", documentRoutes);

app.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") {
    return res.status(413).json({ code: "REQUEST_TOO_LARGE", message: "The request is too large." });
  }
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ code: "INVALID_REQUEST_BODY", message: "The request body is invalid." });
  }
  console.error("Unhandled API error:", error);
  res.status(500).json({ code: "INTERNAL_ERROR", message: "An unexpected server error occurred." });
});

async function start() {
  const missingAuthSettings = ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "CLERK_WEBHOOK_SIGNING_SECRET", "ADMIN_SESSION_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET"]
    .filter((name) => !process.env[name]);
  if (process.env.ADMIN_SESSION_SECRET && process.env.ADMIN_SESSION_SECRET.length < 32) {
    missingAuthSettings.push("ADMIN_SESSION_SECRET (must be at least 32 characters)");
  }
  if (missingAuthSettings.length > 0) {
    console.error(`Missing required environment settings: ${missingAuthSettings.join(", ")}`);
    process.exit(1);
  }

  try {
    await prisma.$connect();
    app.listen(port, () => console.log(`IRIS API listening on port ${port}`));
  } catch (error) {
    console.error("Database connection failed:", error);
    process.exit(1);
  }
}

start();
