import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { OfficeParser } from "officeparser";
import { PDFParse } from "pdf-parse";

import prisma from "../config/prisma.js";
import { createSignedUrl, downloadFile } from "../services/supabaseStorage.js";
import { getQdrantStatus, qdrantSettings, replaceDocumentPoints, syncDocumentAccess } from "../services/qdrant.js";

const router = Router();
const cookieName = "iris_admin_session";
const sessionLifetimeSeconds = 8 * 60 * 60;
const loginAttempts = new Map();

function chunkText(text, maxLength = 1000, overlap = 160) {
  const normalized = text.replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxLength, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(" ", end);
      if (boundary > start + maxLength * 0.65) end = boundary;
    }
    const value = normalized.slice(start, end).trim();
    if (value) chunks.push(value);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

async function extractDocumentText(buffer, filename) {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "txt") return buffer.toString("utf8");
  if (extension === "pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  const ast = await OfficeParser.parseOffice(buffer, { fileType: extension });
  return (await ast.to("text")).value;
}

function stablePointId(documentId, index) {
  const hex = createHash("sha256").update(`${documentId}:${index}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function processIngestionJob(jobId, documentId) {
  try {
    const document = await prisma.documents.findUnique({
      where: { document_id: documentId },
      include: { depts: { select: { dept_id: true, dept_name: true } }, document_access: { select: { user_id: true, dept_id: true } } },
    });
    if (!document || document.status !== "approved") throw new Error("Only approved documents can be indexed.");

    const source = await downloadFile(document.storage_path);
    const text = await extractDocumentText(source, document.original_filename);
    if (!text?.trim()) throw new Error("No searchable text was found. Scanned PDFs need OCR before they can be indexed.");
    if (text.length > 5_000_000) throw new Error("Extracted text is larger than the 5 MB indexing limit.");

    const textChunks = chunkText(text);
    if (!textChunks.length) throw new Error("No searchable text was found in this document.");
    await prisma.ingestion_jobs.update({ where: { ingestion_job_id: jobId }, data: { discovered_count: textChunks.length } });

    const departments = [...new Set([document.dept_id, ...document.document_access.map((grant) => grant.dept_id).filter(Boolean)])];
    const users = [...new Set(document.document_access.map((grant) => grant.user_id).filter(Boolean))];
    const points = await replaceDocumentPoints(documentId, textChunks.map((value, index) => ({ id: stablePointId(documentId, index), index, text: value })), {
      documentId,
      title: document.title,
      filename: document.original_filename,
      description: document.description || "",
      category: document.metadata?.category || "other",
      tags: document.metadata?.tags || [],
      departmentId: document.dept_id,
      departmentName: document.depts.dept_name,
      accessDepartmentIds: departments,
      accessUserIds: users,
      approvedAt: document.approved_at?.toISOString() || null,
      updatedAt: new Date().toISOString(),
    }, async (processedCount) => {
      await prisma.ingestion_jobs.update({ where: { ingestion_job_id: jobId }, data: { processed_count: processedCount } });
    });
    await prisma.ingestion_jobs.update({
      where: { ingestion_job_id: jobId },
      data: { status: "completed", processed_count: points, failed_count: 0, completed_at: new Date(), error_message: null },
    });
  } catch (error) {
    console.error(`Ingestion job ${jobId} failed:`, error);
    await prisma.ingestion_jobs.update({
      where: { ingestion_job_id: jobId },
      data: { status: "failed", failed_count: 1, completed_at: new Date(), error_message: String(error.message || "Indexing failed.").slice(0, 2000) },
    }).catch((updateError) => console.error("Could not save ingestion failure:", updateError));
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signSession(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Math.floor(Date.now() / 1000) + sessionLifetimeSeconds,
  })).toString("base64url");
  const signature = createHmac("sha256", process.env.ADMIN_SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readCookie(req, name) {
  const entry = req.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

function verifySession(req) {
  const token = readCookie(req, cookieName);
  if (!token) return false;
  const [payload, suppliedSignature, extraPart] = token.split(".");
  if (!payload || !suppliedSignature || extraPart !== undefined) return false;

  const expectedSignature = createHmac("sha256", process.env.ADMIN_SESSION_SECRET).update(payload).digest();
  const receivedSignature = Buffer.from(suppliedSignature, "base64url");
  if (expectedSignature.length !== receivedSignature.length || !timingSafeEqual(expectedSignature, receivedSignature)) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.username === (process.env.DEMO_ADMIN_USERNAME || "admin")
      && Number(session.expiresAt) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!verifySession(req)) {
    return res.status(401).json({ code: "ADMIN_SESSION_REQUIRED", message: "Sign in as an administrator to continue." });
  }
  next();
}

function setAdminCookie(res, username) {
  res.cookie(cookieName, signSession(username), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
    maxAge: sessionLifetimeSeconds * 1000,
    path: "/api/admin",
  });
}

function adminDisplayName() {
  return process.env.DEMO_ADMIN_DISPLAY_NAME || "Admin";
}

router.post("/session", (req, res) => {
  const address = req.ip || "unknown";
  const now = Date.now();
  const attempts = loginAttempts.get(address);
  if (attempts && attempts.resetAt > now && attempts.count >= 8) {
    return res.status(429).json({ code: "LOGIN_RATE_LIMITED", message: "Too many attempts. Wait a few minutes and try again." });
  }

  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const expectedUsername = process.env.DEMO_ADMIN_USERNAME || "admin";
  const expectedPassword = process.env.DEMO_ADMIN_PASSWORD || "irisadmin123";
  if (!safeEqual(username, expectedUsername) || !safeEqual(password, expectedPassword)) {
    const current = attempts && attempts.resetAt > now ? attempts : { count: 0, resetAt: now + 10 * 60 * 1000 };
    current.count += 1;
    loginAttempts.set(address, current);
    return res.status(401).json({ code: "INVALID_ADMIN_CREDENTIALS", message: "Admin name or password is incorrect." });
  }

  loginAttempts.delete(address);
  setAdminCookie(res, expectedUsername);
  return res.json({ authenticated: true, displayName: adminDisplayName() });
});

router.get("/session", (req, res) => {
  if (!verifySession(req)) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, displayName: adminDisplayName() });
});

router.delete("/session", requireAdmin, (_req, res) => {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
    path: "/api/admin",
  });
  return res.status(204).end();
});

router.get("/dashboard", requireAdmin, async (_req, res) => {
  try {
    const today = new Date();
    const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29));
    const [
      totalDocuments,
      pendingReview,
      storage,
      activeUsers,
      departments,
      pendingAccessRequests,
      failedIngestionJobs,
      latestDocumentJobs,
      dailyUploadRows,
      recentDocuments,
      recentUsers,
      recentJobs,
    ] = await Promise.all([
      prisma.documents.count(),
      prisma.documents.count({ where: { status: "pending_review" } }),
      prisma.documents.aggregate({ _sum: { file_size: true } }),
      prisma.users.count({ where: { status: "active" } }),
      prisma.depts.count({ where: { is_active: true } }),
      prisma.access_requests.count({ where: { status: "pending" } }),
      prisma.ingestion_jobs.count({ where: { status: "failed" } }),
      prisma.ingestion_jobs.findMany({
        where: { document_id: { not: null }, documents: { status: "approved" } },
        orderBy: { created_at: "desc" },
        distinct: ["document_id"],
        select: { document_id: true, status: true },
      }),
      prisma.$queryRaw`
        SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS count
        FROM documents
        WHERE created_at >= ${startDate}
        GROUP BY date_trunc('day', created_at)
        ORDER BY day ASC
      `,
      prisma.documents.findMany({
        take: 8,
        orderBy: { created_at: "desc" },
        select: { title: true, original_filename: true, created_at: true, status: true },
      }),
      prisma.users.findMany({
        take: 8,
        orderBy: { created_at: "desc" },
        select: { full_name: true, email: true, created_at: true },
      }),
      prisma.ingestion_jobs.findMany({
        take: 8,
        orderBy: { created_at: "desc" },
        include: { documents: { select: { title: true, original_filename: true } } },
      }),
    ]);

    const recentActivity = [
      ...recentDocuments.map((document) => ({
        type: "document",
        title: "Document uploaded",
        description: document.title || document.original_filename,
        createdAt: document.created_at,
      })),
      ...recentUsers.map((user) => ({
        type: "user",
        title: "Employee registered",
        description: user.full_name || user.email,
        createdAt: user.created_at,
      })),
      ...recentJobs.map((job) => ({
        type: "ingestion",
        title: job.status === "completed" ? "Indexing completed" : `Indexing ${job.status}`,
        description: job.documents?.title || job.documents?.original_filename || "Document",
        createdAt: job.created_at,
      })),
    ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 8);

    return res.json({
      displayName: adminDisplayName(),
      metrics: {
        totalDocuments,
        indexedDocuments: latestDocumentJobs.filter((job) => job.status === "completed").length,
        pendingReview,
        failedIngestionJobs,
        activeUsers,
        departments,
        storageBytes: (storage._sum.file_size || 0n).toString(),
        pendingAccessRequests,
      },
      dailyUploads: dailyUploadRows.map((row) => ({ day: row.day, count: Number(row.count) })),
      recentActivity,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Unable to load admin dashboard:", error);
    return res.status(503).json({ code: "ADMIN_DASHBOARD_UNAVAILABLE", message: "Could not load dashboard data." });
  }
});

router.get("/departments", requireAdmin, async (_req, res) => {
  try {
    const departments = await prisma.depts.findMany({
      where: { is_active: true },
      select: { dept_id: true, dept_name: true },
      orderBy: { dept_name: "asc" },
    });
    return res.json({ departments });
  } catch (error) {
    console.error("Unable to load departments for admin:", error);
    return res.status(503).json({ code: "DEPARTMENTS_UNAVAILABLE", message: "Could not load departments." });
  }
});

router.post("/departments", requireAdmin, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ code: "INVALID_DEPARTMENT_NAME", message: "Enter a department name between 2 and 100 characters." });
  }
  if (description.length > 500) {
    return res.status(400).json({ code: "INVALID_DEPARTMENT_DESCRIPTION", message: "Department description must be 500 characters or fewer." });
  }

  try {
    const existing = await prisma.depts.findFirst({
      where: { dept_name: { equals: name, mode: "insensitive" } },
      select: { dept_id: true, dept_name: true, is_active: true },
    });
    if (existing?.is_active) {
      return res.status(409).json({ code: "DEPARTMENT_ALREADY_EXISTS", message: "An active department already uses that name." });
    }
    const department = existing
      ? await prisma.depts.update({
        where: { dept_id: existing.dept_id },
        data: { dept_name: name, description: description || null, is_active: true },
        select: { dept_id: true, dept_name: true },
      })
      : await prisma.depts.create({
        data: { dept_name: name, description: description || null },
        select: { dept_id: true, dept_name: true },
      });
    return res.status(existing ? 200 : 201).json({ department });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ code: "DEPARTMENT_ALREADY_EXISTS", message: "A department already uses that name." });
    }
    console.error("Unable to create department:", error);
    return res.status(503).json({ code: "DEPARTMENT_CREATE_UNAVAILABLE", message: "Could not create the department right now." });
  }
});

router.get("/users", requireAdmin, async (_req, res) => {
  try {
    const users = await prisma.users.findMany({
      take: 100,
      orderBy: { created_at: "desc" },
      select: {
        user_id: true,
        full_name: true,
        email: true,
        employee_code: true,
        role: true,
        status: true,
        clerk_user_id: true,
        created_at: true,
        depts: { select: { dept_name: true } },
      },
    });
    return res.json({ users: users.map((user) => ({
      id: user.user_id,
      name: user.full_name,
      email: user.email,
      employeeCode: user.employee_code,
      role: user.role,
      status: user.status,
      hasCompletedSignup: Boolean(user.clerk_user_id),
      createdAt: user.created_at,
      department: user.depts.dept_name,
    })) });
  } catch (error) {
    console.error("Unable to load users for admin:", error);
    return res.status(503).json({ code: "USERS_UNAVAILABLE", message: "Could not load users." });
  }
});

router.post("/users/:userId/approve", requireAdmin, async (req, res) => {
  const userId = req.params.userId;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return res.status(400).json({ code: "INVALID_USER_ID", message: "The selected user ID is invalid." });
  }

  try {
    const user = await prisma.users.findUnique({
      where: { user_id: userId },
      select: { user_id: true, full_name: true, email: true, status: true, clerk_user_id: true },
    });
    if (!user) return res.status(404).json({ code: "USER_NOT_FOUND", message: "This roster user could not be found." });
    if (!user.clerk_user_id) {
      return res.status(409).json({ code: "SIGNUP_NOT_COMPLETED", message: "This employee must complete Clerk sign-up before access can be approved." });
    }
    if (user.status === "active") return res.json({ user: { id: user.user_id, status: user.status } });
    if (user.status !== "pending") {
      return res.status(409).json({ code: "USER_NOT_PENDING", message: "Only a pending employee account can be approved." });
    }

    const approved = await prisma.users.update({
      where: { user_id: user.user_id },
      data: { status: "active", updated_at: new Date() },
      select: { user_id: true, status: true },
    });
    return res.json({ user: { id: approved.user_id, name: user.full_name, email: user.email, status: approved.status } });
  } catch (error) {
    console.error("Unable to approve roster user:", error);
    return res.status(503).json({ code: "USER_APPROVAL_UNAVAILABLE", message: "Could not approve this account right now." });
  }
});

router.get("/documents", requireAdmin, async (_req, res) => {
  try {
    const documents = await prisma.documents.findMany({
      take: 100,
      orderBy: { created_at: "desc" },
      include: {
        depts: { select: { dept_id: true, dept_name: true } },
        users: { select: { full_name: true, email: true } },
        document_reviews: { orderBy: { created_at: "desc" }, take: 1, select: { comments: true, review_status: true, reviewed_at: true } },
        document_access: { select: { dept_id: true } },
      },
    });
    return res.json({ documents: documents.map((document) => ({
      id: document.document_id,
      title: document.title,
      filename: document.original_filename,
      mimeType: document.mime_type,
      fileSize: document.file_size?.toString() ?? null,
      description: document.description,
      category: document.metadata?.category ?? "other",
      tags: document.metadata?.tags ?? [],
      status: document.status,
      departmentId: document.dept_id,
      department: document.depts.dept_name,
      sharedDepartmentIds: document.document_access.map((grant) => grant.dept_id).filter(Boolean),
      uploader: document.users?.full_name ?? "Unknown",
      uploaderEmail: document.users?.email ?? "",
      createdAt: document.created_at,
      review: document.document_reviews[0] ?? null,
    })) });
  } catch (error) {
    console.error("Unable to list admin documents:", error);
    return res.status(503).json({ code: "ADMIN_DOCUMENT_LIST_UNAVAILABLE", message: "Could not load the document review queue." });
  }
});

router.get("/access-requests", requireAdmin, async (_req, res) => {
  try {
    const requests = await prisma.access_requests.findMany({
      take: 100,
      orderBy: [{ status: "asc" }, { created_at: "desc" }],
      include: {
        documents: { select: { document_id: true, title: true, status: true, dept_id: true, depts: { select: { dept_name: true } } } },
        depts: { select: { dept_id: true, dept_name: true } },
        users_access_requests_requester_idTousers: { select: { user_id: true, full_name: true, email: true } },
      },
    });
    return res.json({ requests: requests.map((request) => ({
      id: request.request_id,
      status: request.status,
      reason: request.reason,
      createdAt: request.created_at,
      reviewedAt: request.reviewed_at,
      reviewerComment: request.reviewer_comment,
      document: { id: request.documents.document_id, title: request.documents.title, status: request.documents.status, departmentId: request.documents.dept_id, department: request.documents.depts.dept_name },
      requestingDepartment: { id: request.depts.dept_id, name: request.depts.dept_name },
      requester: { id: request.users_access_requests_requester_idTousers.user_id, name: request.users_access_requests_requester_idTousers.full_name, email: request.users_access_requests_requester_idTousers.email },
    })) });
  } catch (error) {
    console.error("Unable to list document access requests:", error);
    return res.status(503).json({ code: "ACCESS_REQUEST_LIST_UNAVAILABLE", message: "Could not load access requests." });
  }
});

router.post("/access-requests/:requestId/review", requireAdmin, async (req, res) => {
  const requestId = req.params.requestId;
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return res.status(400).json({ code: "INVALID_REQUEST_ID", message: "The access request ID is invalid." });
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ code: "INVALID_REVIEW_ACTION", message: "Choose approve or reject." });
  if (comment.length > 2000) return res.status(400).json({ code: "INVALID_REVIEW_COMMENT", message: "The review note must be 2,000 characters or fewer." });

  try {
    const request = await prisma.access_requests.findUnique({
      where: { request_id: requestId },
      include: { documents: { select: { document_id: true, status: true, dept_id: true } } },
    });
    if (!request) return res.status(404).json({ code: "ACCESS_REQUEST_NOT_FOUND", message: "Access request not found." });
    if (request.status !== "pending") return res.status(409).json({ code: "ACCESS_REQUEST_ALREADY_REVIEWED", message: "This access request has already been reviewed." });
    if (action === "approve" && request.documents.status !== "approved") {
      return res.status(409).json({ code: "DOCUMENT_NOT_APPROVED", message: "The document must be approved before access can be granted." });
    }
    if (action === "approve") {
      const requestingDepartment = await prisma.depts.findFirst({
        where: { dept_id: request.requested_from_dept, is_active: true },
        select: { dept_id: true },
      });
      if (!requestingDepartment) return res.status(409).json({ code: "REQUESTING_DEPARTMENT_INACTIVE", message: "The requesting department is no longer active." });
    }

    await prisma.$transaction(async (tx) => {
      const updated = await tx.access_requests.updateMany({
        where: { request_id: requestId, status: "pending" },
        data: {
          status: action === "approve" ? "approved" : "rejected",
          reviewer_comment: comment || null,
          reviewed_at: new Date(),
        },
      });
      if (updated.count !== 1) {
        const conflict = new Error("Access request is no longer pending.");
        conflict.code = "ACCESS_REQUEST_ALREADY_REVIEWED";
        throw conflict;
      }
      if (action === "approve" && request.requested_from_dept !== request.documents.dept_id) {
        const existingGrant = await tx.document_access.findFirst({
          where: { document_id: request.document_id, dept_id: request.requested_from_dept },
          select: { document_access_id: true },
        });
        if (!existingGrant) {
          await tx.document_access.create({
            data: { document_id: request.document_id, dept_id: request.requested_from_dept, access_level: "read" },
          });
        }
      }
    });
    if (action === "approve") {
      try {
        const grants = await prisma.document_access.findMany({
          where: { document_id: request.document_id },
          select: { dept_id: true, user_id: true },
        });
        await syncDocumentAccess(
          request.document_id,
          [request.documents.dept_id, ...grants.map((grant) => grant.dept_id).filter(Boolean)],
          grants.map((grant) => grant.user_id).filter(Boolean),
        );
      } catch (syncError) {
        console.error("Could not sync approved access grant to Qdrant:", syncError);
      }
    }
    return res.json({ request: { id: requestId, status: action === "approve" ? "approved" : "rejected" } });
  } catch (error) {
    if (error.code === "ACCESS_REQUEST_ALREADY_REVIEWED") {
      return res.status(409).json({ code: error.code, message: "This access request has already been reviewed." });
    }
    console.error("Unable to review access request:", error);
    return res.status(503).json({ code: "ACCESS_REQUEST_REVIEW_UNAVAILABLE", message: "Could not save this access decision." });
  }
});

router.get("/documents/:documentId/download", requireAdmin, async (req, res) => {
  try {
    const document = await prisma.documents.findUnique({ where: { document_id: req.params.documentId }, select: { storage_path: true, original_filename: true } });
    if (!document) return res.status(404).json({ code: "DOCUMENT_NOT_FOUND", message: "Document not found." });
    const url = await createSignedUrl(document.storage_path, 300);
    return res.json({ url, filename: document.original_filename, expiresIn: 300 });
  } catch (error) {
    console.error("Unable to create admin document link:", error);
    return res.status(503).json({ code: "DOCUMENT_DOWNLOAD_UNAVAILABLE", message: "Could not create a preview link." });
  }
});

router.post("/documents/:documentId/review", requireAdmin, async (req, res) => {
  const documentId = req.params.documentId;
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  const comments = typeof req.body?.comments === "string" ? req.body.comments.trim() : "";
  const requestedDepartmentIds = Array.isArray(req.body?.departmentIds) ? [...new Set(req.body.departmentIds)] : [];
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return res.status(400).json({ code: "INVALID_DOCUMENT_ID", message: "The selected document ID is invalid." });
  if (!["approve", "reject"].includes(action)) return res.status(400).json({ code: "INVALID_REVIEW_ACTION", message: "Choose approve or reject." });
  if (comments.length > 2000 || requestedDepartmentIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
    return res.status(400).json({ code: "INVALID_REVIEW_DETAILS", message: "Check the review comment and department selections." });
  }

  try {
    const document = await prisma.documents.findUnique({ where: { document_id: documentId }, select: { document_id: true, dept_id: true, status: true } });
    if (!document) return res.status(404).json({ code: "DOCUMENT_NOT_FOUND", message: "Document not found." });
    if (document.status !== "pending_review") {
      return res.status(409).json({ code: "DOCUMENT_NOT_PENDING", message: "Only documents pending review can be approved or rejected." });
    }

    const extraDepartmentIds = requestedDepartmentIds.filter((id) => id !== document.dept_id);
    if (action === "reject" && extraDepartmentIds.length) {
      return res.status(400).json({ code: "REJECT_CANNOT_SHARE", message: "Rejected documents cannot be shared." });
    }
    if (extraDepartmentIds.length) {
      const departments = await prisma.depts.findMany({ where: { dept_id: { in: extraDepartmentIds }, is_active: true }, select: { dept_id: true } });
      if (departments.length !== extraDepartmentIds.length) return res.status(400).json({ code: "INVALID_SHARE_DEPARTMENT", message: "One or more selected departments are unavailable." });
    }

    const status = action === "approve" ? "approved" : "rejected";
    await prisma.$transaction(async (tx) => {
      const updated = await tx.documents.updateMany({
        where: { document_id: documentId, status: "pending_review" },
        data: { status, approved_at: action === "approve" ? new Date() : null, updated_at: new Date() },
      });
      if (updated.count !== 1) {
        const conflict = new Error("Document is no longer pending review.");
        conflict.code = "DOCUMENT_NOT_PENDING";
        throw conflict;
      }
      await tx.document_reviews.create({
        data: {
          document_id: documentId,
          review_status: status,
          comments: comments || null,
          reviewed_at: new Date(),
        },
      });
      if (action === "approve" && extraDepartmentIds.length) {
        await tx.document_access.createMany({
          data: extraDepartmentIds.map((deptId) => ({ document_id: documentId, dept_id: deptId, access_level: "read" })),
        });
      }
    });
    return res.json({ document: { id: documentId, status, sharedDepartmentIds: extraDepartmentIds } });
  } catch (error) {
    if (error.code === "DOCUMENT_NOT_PENDING") {
      return res.status(409).json({ code: error.code, message: "This document has already been reviewed." });
    }
    console.error("Unable to review document:", error);
    return res.status(503).json({ code: "DOCUMENT_REVIEW_UNAVAILABLE", message: "Could not save the document review." });
  }
});

router.post("/users/invitations", requireAdmin, async (req, res) => {
  const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const employeeCode = typeof req.body?.employeeCode === "string" ? req.body.employeeCode.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const departmentId = typeof req.body?.departmentId === "string" ? req.body.departmentId : "";
  const requestedRole = typeof req.body?.role === "string" ? req.body.role : "employee";
  const allowedRoles = new Set(["employee", "reviewer", "dept_admin"]);

  if (fullName.length < 2 || fullName.length > 150) {
    return res.status(400).json({ code: "INVALID_NAME", message: "Enter a name between 2 and 150 characters." });
  }
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: "INVALID_EMAIL", message: "Enter a valid email address." });
  }
  if (employeeCode.length > 50 || title.length > 100) {
    return res.status(400).json({ code: "INVALID_DETAILS", message: "Employee code or job title is too long." });
  }
  if (!allowedRoles.has(requestedRole)) {
    return res.status(400).json({ code: "INVALID_ROLE", message: "Choose a supported employee role." });
  }

  try {
    const department = await prisma.depts.findFirst({
      where: { dept_id: departmentId, is_active: true },
      select: { dept_id: true, dept_name: true },
    });
    if (!department) return res.status(400).json({ code: "INVALID_DEPARTMENT", message: "Select an active department." });

    const existingUser = await prisma.users.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { user_id: true },
    });
    if (existingUser) {
      return res.status(409).json({ code: "USER_ALREADY_EXISTS", message: "An IRIS account already uses this email." });
    }

    const rosterUser = await prisma.users.create({
      data: {
        full_name: fullName,
        email,
        employee_code: employeeCode || null,
        dept_id: department.dept_id,
        role: requestedRole,
        status: "pending",
      },
      select: { user_id: true },
    });

    try {
      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        notify: true,
        redirectUrl: new URL("/accept-invitation", process.env.FRONTEND_URL || "http://localhost:5173").toString(),
        publicMetadata: {
          full_name: fullName,
          department: department.dept_name,
          department_id: department.dept_id,
          employee_code: employeeCode || null,
          title: title || null,
          role: requestedRole,
        },
      });

      return res.status(201).json({
        user: { id: rosterUser.user_id, name: fullName, email, department: department.dept_name, role: requestedRole, status: "pending" },
        invitation: { id: invitation.id, status: invitation.status, url: invitation.url || null },
        notificationRequested: true,
      });
    } catch (clerkError) {
      await prisma.users.delete({ where: { user_id: rosterUser.user_id } }).catch((cleanupError) => {
        console.error("Unable to remove pending roster after Clerk invite failure:", cleanupError);
      });
      const status = clerkError.status === 422 || clerkError.status === 409 ? 409 : 502;
      return res.status(status).json({
        code: status === 409 ? "CLERK_INVITATION_CONFLICT" : "CLERK_INVITATION_FAILED",
        message: status === 409 ? "Clerk already has this user or a pending invitation." : "Clerk could not send the invitation. Try again shortly.",
      });
    }
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ code: "USER_CONFLICT", message: "That email or employee code is already in use." });
    }
    console.error("Unable to create invitation:", error);
    return res.status(503).json({ code: "INVITATION_UNAVAILABLE", message: "Could not register this user right now." });
  }
});

router.get("/ingestion", requireAdmin, async (_req, res) => {
  try {
    const [documents, jobs, qdrant] = await Promise.all([
      prisma.documents.findMany({
        where: { status: "approved" }, take: 100, orderBy: { updated_at: "desc" },
        include: { depts: { select: { dept_name: true } }, users: { select: { full_name: true } }, ingestion_jobs: { orderBy: { created_at: "desc" }, take: 1 } },
      }),
      prisma.ingestion_jobs.findMany({ take: 100, orderBy: { created_at: "desc" }, include: { documents: { select: { title: true, original_filename: true } } } }),
      getQdrantStatus(),
    ]);
    return res.json({
      settings: qdrantSettings(), qdrant,
      documents: documents.map((document) => {
        const job = document.ingestion_jobs[0];
        return {
          id: document.document_id, title: document.title, filename: document.original_filename,
          department: document.depts.dept_name, uploader: document.users?.full_name || "Unknown", approvedAt: document.approved_at,
          latestJob: job ? { id: job.ingestion_job_id, status: job.status, chunks: job.processed_count, discoveredChunks: job.discovered_count, error: job.error_message, createdAt: job.created_at, completedAt: job.status === "completed" ? job.completed_at : null } : null,
        };
      }),
      jobs: jobs.map((job) => ({
        id: job.ingestion_job_id, documentId: job.document_id, title: job.documents?.title || "Document unavailable",
        filename: job.documents?.original_filename || "", status: job.status, chunks: job.processed_count,
        discoveredChunks: job.discovered_count, failedCount: job.failed_count, error: job.error_message,
        createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
      })),
    });
  } catch (error) {
    console.error("Unable to load ingestion monitor:", error);
    return res.status(503).json({ code: "INGESTION_MONITOR_UNAVAILABLE", message: "Could not load the ingestion monitor." });
  }
});

router.post("/ingestion/:documentId", requireAdmin, async (req, res) => {
  const documentId = req.params.documentId;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return res.status(400).json({ code: "INVALID_DOCUMENT_ID", message: "The selected document ID is invalid." });
  try {
    const [document, qdrant] = await Promise.all([
      prisma.documents.findUnique({ where: { document_id: documentId }, select: { document_id: true, status: true } }),
      getQdrantStatus(),
    ]);
    if (!document) return res.status(404).json({ code: "DOCUMENT_NOT_FOUND", message: "Document not found." });
    if (document.status !== "approved") return res.status(409).json({ code: "DOCUMENT_NOT_APPROVED", message: "Only approved documents can be indexed." });
    if (!qdrant.configured || !qdrant.connected) return res.status(503).json({ code: "QDRANT_UNAVAILABLE", message: qdrant.error || "Connect Qdrant before starting ingestion." });
    const existing = await prisma.ingestion_jobs.findFirst({
      where: { document_id: documentId, status: { in: ["queued", "running"] } }, select: { ingestion_job_id: true, status: true },
    });
    if (existing) return res.status(409).json({ code: "INGESTION_ALREADY_RUNNING", message: "This document already has an active indexing job.", job: { id: existing.ingestion_job_id, status: existing.status } });
    const job = await prisma.ingestion_jobs.create({
      data: { document_id: documentId, status: "running", started_at: new Date() },
      select: { ingestion_job_id: true, status: true, created_at: true },
    });
    void processIngestionJob(job.ingestion_job_id, documentId);
    return res.status(202).json({ job: { id: job.ingestion_job_id, status: job.status, createdAt: job.created_at } });
  } catch (error) {
    console.error("Unable to start document ingestion:", error);
    return res.status(503).json({ code: "INGESTION_START_UNAVAILABLE", message: "Could not start indexing for this document." });
  }
});

export default router;
