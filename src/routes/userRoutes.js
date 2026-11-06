import { Router } from "express";
import { clerkClient, getAuth } from "@clerk/express";

import prisma from "../config/prisma.js";
import { linkExistingUserByEmail } from "../services/userService.js";

const router = Router();

router.get("/me", async (req, res) => {
  const { isAuthenticated, userId } = getAuth(req);
  if (!isAuthenticated || !userId) {
    return res.status(401).json({ code: "UNAUTHENTICATED", message: "Sign in to continue." });
  }

  try {
    let appUser = await prisma.users.findUnique({
      where: { clerk_user_id: userId },
      include: { depts: { select: { dept_name: true } } },
    });

    // Link pre-existing IRIS roster records by the authenticated Clerk email.
    // This never creates a database account; new records come from the signed user.created webhook.
    if (!appUser) {
      const clerkUser = await clerkClient.users.getUser(userId);
      const primaryEmail = clerkUser.emailAddresses.find(
        (address) => address.id === clerkUser.primaryEmailAddressId,
      );
      if (primaryEmail?.verification?.status !== "verified") {
        return res.status(403).json({
          code: "EMAIL_NOT_VERIFIED",
          message: "Verify your Clerk email before accessing your IRIS account.",
        });
      }
      const linkedUser = await linkExistingUserByEmail(userId, primaryEmail.emailAddress);
      if (linkedUser) {
        appUser = await prisma.users.findUnique({
          where: { user_id: linkedUser.user_id },
          include: { depts: { select: { dept_name: true } } },
        });
      }
    }

    if (!appUser) {
      return res.status(403).json({
        code: "ACCOUNT_NOT_REGISTERED",
        message: "Your account is not registered in IRIS. Ask an administrator to invite you.",
      });
    }

    if (appUser.status !== "active") {
      const awaitingApproval = appUser.status === "pending" && Boolean(appUser.clerk_user_id);
      return res.status(403).json({
        code: awaitingApproval ? "ACCOUNT_AWAITING_APPROVAL" : appUser.status === "pending" ? "ACCOUNT_SYNC_PENDING" : "ACCOUNT_NOT_ACTIVE",
        message: awaitingApproval
          ? "Your sign-up is complete and is awaiting administrator approval."
          : appUser.status === "pending"
          ? "Your account is awaiting Clerk registration sync. Try again shortly."
          : "Your IRIS account is not active. Contact your administrator.",
      });
    }

    await prisma.users.update({
      where: { user_id: appUser.user_id },
      data: { last_login_at: new Date() },
    });

    return res.json({
      user: {
        id: appUser.user_id,
        clerkUserId: appUser.clerk_user_id,
        departmentId: appUser.dept_id,
        fullName: appUser.full_name,
        email: appUser.email,
        employeeCode: appUser.employee_code,
        department: appUser.depts.dept_name,
        role: appUser.role,
        status: appUser.status,
      },
    });
  } catch (error) {
    console.error("Unable to verify IRIS user record:", error);
    return res.status(503).json({
      code: "USER_LOOKUP_UNAVAILABLE",
      message: "IRIS could not verify your account. Please try again shortly.",
    });
  }
});

export default router;
